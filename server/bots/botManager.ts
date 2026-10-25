import { generatePlayerName } from "../playerNames.js";
import { collectReusableAnswers } from "../database/researchRecords.js";
import type { AnswerOrigin, Player, Room } from "../types.js";
import type { BotSettings, Range } from "./botSettings.js";
import { randomInRange } from "./botSettings.js";
import { desiredBotCount, shouldHandHostToHuman } from "./population.js";
import { planBotAnswers, randomAnswer } from "./answerSources.js";
import type { PregeneratedPool, ReusableAnswerPool } from "./answerSources.js";

/** Room operations the bot manager drives; the server implements them with its normal game flow. */
export type BotHost = {
    rooms(): Iterable<Room>;
    usedNames(): Set<string>;
    addPlayer(room: Room, player: Player): void;
    removePlayer(room: Room, player: Player): void;
    transferHost(room: Room, playerId: string): void;
    startRound(room: Room, player: Player): boolean;
    submitAnswer(room: Room, player: Player, words: string[], origin: AnswerOrigin): boolean;
    submitRanking(room: Room, player: Player, answerIds: string[]): boolean;
    readyForNextRound(room: Room, player: Player): boolean;
    resetGame(room: Room): void;
    sendEmote(room: Room, player: Player, emoteId: string): void;
};

export type BotManagerOptions = {
    config: BotSettings;
    minPlayersToStart: number;
    capacity: number;
    pregenerated: PregeneratedPool;
    reusable: ReusableAnswerPool;
    random?: () => number;
    now?: () => number;
};

type BotAction = { fireAt: number; timer: NodeJS.Timeout };

type RoomBotState = {
    background: boolean;
    paused: boolean; // by an admin
    hostDisabled: boolean;
    backgroundTarget: number;
    assistTarget: number;
    nextRetargetAt: number;
    nextAutoRoundAt: number;
    pendingChange: "add" | "remove" | null;
    changeAt: number | null;
    assistJoins: number; // bots added since the room's humans became short of players
    actions: Map<string, BotAction>;
    plans: { gameId: string; round: number; byBot: Map<string, { words: string[]; origin: AnswerOrigin }> } | null;
    emoteTimers: Set<NodeJS.Timeout>;
    greetingsBy: Map<string, number>; // greetings each human has sent in this room
};

const TICK_MS = 1_000;

export class BotManager {
    private readonly states = new Map<string, RoomBotState>();
    private ticker: NodeJS.Timeout | null = null;
    private paused: boolean;
    private readonly config: BotSettings;
    private readonly random: () => number;
    private readonly now: () => number;

    constructor(private readonly host: BotHost, private readonly options: BotManagerOptions) {
        this.config = options.config;
        this.paused = !options.config.enabled;
        this.random = options.random ?? Math.random;
        this.now = options.now ?? Date.now;
    }

    /**
     * Paused bots leave between rounds and start no rounds of their own; they still finish a round
     * in progress. Without a room this is the global pause, with one only that room's own setting.
     */
    isPaused(roomId?: string): boolean {
        return roomId === undefined ? this.paused : this.states.get(roomId)?.paused ?? false;
    }

    setPaused(paused: boolean, room?: Room): void {
        if (room) this.state(room).paused = paused;
        else this.paused = paused;
    }

    /** The host's choice for their room; unlike an admin pause it ends with the room's session. */
    isDisabledByHost(roomId: string): boolean {
        return this.states.get(roomId)?.hostDisabled ?? false;
    }

    setDisabledByHost(room: Room, disabled: boolean): void {
        this.state(room).hostDisabled = disabled;
    }

    start(): void {
        if (this.ticker) return;

        const rooms = [...this.host.rooms()];
        const count = Math.min(rooms.length, randomInRange(this.config.backgroundRooms, this.random));
        for (const room of this.shuffled(rooms).slice(0, count)) {
            const state = this.state(room);
            state.background = true;
            // populate straight away, so the server never starts with every room empty
            while (!this.paused && this.botsIn(room).length < state.backgroundTarget && this.addBot(room)) { /* keep adding */ }
        }
        console.log(`Bots populate background rooms: ${[...this.states].filter(([, s]) => s.background).map(([id]) => id).join(", ")}`);

        this.ticker = setInterval(() => this.tick(), TICK_MS);
    }

    stop(): void {
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        for (const state of this.states.values()) this.clearActions(state);
    }

    isBackgroundRoom(room: Room): boolean {
        return this.states.get(room.id)?.background ?? false;
    }

    tick(now: number = this.now()): void {
        for (const room of this.host.rooms()) {
            try {
                this.evaluate(room, now);
            } catch (error) {
                console.error(`Bot manager failed in room ${room.id}:`, error);
            }
        }
    }


    // ---- hooks called by the server ----

    /** Plans every bot's answer and deals its hand so the answer is playable. */
    onRoundStarted(room: Room): void {
        const game = room.game;
        const round = game.currentRound();
        if (!round?.botPlayerIds?.length) return;

        const bots = new Set(round.botPlayerIds);
        const humansInRoom = [...room.players.values()].filter(player => !player.isBot);
        const plans = planBotAnswers({
            prompt: round.prompt,
            botIds: round.botPlayerIds,
            excludedAuthorIds: new Set(humansInRoom.map(player => player.id)),
            // collected answers are only worth spending on rounds that humans see
            allowReused: round.playerIds.some(id => !bots.has(id)),
            reusedAnswerChance: this.config.reusedAnswerChance,
            pregeneratedAnswerChance: this.config.pregeneratedAnswerChance,
            reuseCooldownMs: this.config.reuseCooldownMs,
            now: this.now(),
            pregenerated: this.options.pregenerated,
            reusable: this.options.reusable,
            random: this.random,
        });

        const byBot = new Map<string, { words: string[]; origin: AnswerOrigin }>();
        for (const [botId, plan] of plans) {
            if (plan.words) {
                game.redealHand(botId, plan.words);
                byBot.set(botId, { words: plan.words, origin: plan.origin });
            } else {
                const hand = round.wordsAvailable.get(botId) ?? [];
                byBot.set(botId, { words: randomAnswer(hand, this.config.randomAnswerWords, this.random), origin: plan.origin });
            }
        }
        if ([...byBot.values()].some(plan => plan.origin.provenance !== "bot_reused_human")) {
            round.containsSyntheticAnswers = true;
        }

        this.state(room).plans = { gameId: game.id, round: game.state.round, byBot };
    }

    /** Collects the humans' original answers from a finished bot-assisted round. */
    onRoundFinished(room: Room): void {
        const collected = collectReusableAnswers(
            room.game,
            room.game.state.round,
            this.config.minReusableAnswerWords,
        );
        const added = this.options.reusable.add(collected);
        if (added.length > 0) {
            console.log(`Room ${room.id}: collected ${added.length} human answer(s) for bot reuse`);
        }
    }

    /** Schedules the pending actions of every bot after any room change; idempotent. */
    onRoomCommitted(room: Room): void {
        const state = this.states.get(room.id);
        if (!state) return;

        const now = this.now();
        const wanted = new Map<string, { delay: Range; run: () => void }>();
        const game = room.game;
        const round = game.currentRound();
        const phase = game.state.phase;
        const hurry = this.humansAreWaiting(room);

        for (const bot of this.botsIn(room)) {
            if (!round || !room.activePlayerIds.has(bot.id)) continue;
            const key = `${game.id}|${game.state.round}|${phase}|${bot.id}`;

            if (phase === "answering" && !round.answers.some(answer => answer.playerId === bot.id)) {
                wanted.set(key, {
                    delay: hurry ? this.config.catchUpDelayMs : this.config.answerDelayMs,
                    run: () => this.answer(room, bot),
                });
            } else if (
                phase === "ranking"
                && !round.rankings.has(bot.id)
                && round.answers.some(answer => answer.playerId !== bot.id)
            ) {
                wanted.set(key, {
                    delay: hurry ? this.config.catchUpDelayMs : this.config.rankingDelayMs,
                    run: () => this.rank(room, bot),
                });
            } else if (phase === "results" && !room.readyPlayers.has(bot.id)) {
                wanted.set(key, {
                    delay: hurry ? this.config.catchUpDelayMs : this.config.readyDelayMs,
                    run: () => this.ready(room, bot),
                });
            }
        }

        for (const [key, action] of state.actions) {
            if (!wanted.has(key)) {
                clearTimeout(action.timer);
                state.actions.delete(key);
            }
        }

        for (const [key, { delay, run }] of wanted) {
            const existing = state.actions.get(key);
            const fireAt = now + this.delayBeforeDeadline(room, delay, now);
            // waiting humans pull an already scheduled bot forward, never push it back
            if (existing && (!hurry || existing.fireAt <= fireAt)) continue;
            if (existing) clearTimeout(existing.timer);

            state.actions.set(key, {
                fireAt,
                timer: setTimeout(() => {
                    state.actions.delete(key);
                    try {
                        run();
                    } catch (error) {
                        console.error(`Bot action failed in room ${room.id}:`, error);
                    }
                }, fireAt - now),
            });
        }
    }

    /** A human's emote: bots sometimes greet back, less often each time the same human greets. */
    onPlayerEmote(room: Room, player: Player, emoteId: string): void {
        const state = this.states.get(room.id);
        if (!state || player.isBot || emoteId !== "greeting") return;

        const earlier = state.greetingsBy.get(player.id) ?? 0;
        state.greetingsBy.set(player.id, earlier + 1);
        const chance = this.config.greetingReplyChance * this.config.greetingReplyDecay ** earlier;
        const bot = this.pick(this.botsIn(room));
        if (!bot || this.random() >= chance) return;

        this.scheduleEmote(room, state, this.config.emoteReplyDelayMs, () => {
            if (room.players.get(bot.id) === bot) this.host.sendEmote(room, bot, "greeting");
        });
    }

    /** The room's game was replaced or the room emptied: forget its scheduled bot actions. */
    onRoomReset(room: Room): void {
        const state = this.states.get(room.id);
        if (!state) return;
        this.clearActions(state);
        state.plans = null;
        state.greetingsBy.clear();
        state.hostDisabled = false;
    }


    // ---- population, host and autonomous rounds ----

    private evaluate(room: Room, now: number): void {
        const state = this.state(room);
        const botsAllowed = !this.paused && !state.paused && !state.hostDisabled;
        const players = [...room.players.values()];
        const humans = players.filter(player => !player.isBot);
        const bots = players.filter(player => player.isBot);
        const humansPresent = humans.filter(player => player.connected || player.reconnecting).length;
        const phase = room.game.state.phase;

        const humanHost = shouldHandHostToHuman(room.hostPlayerId, room.players);
        if (humanHost) {
            this.host.transferHost(room, humanHost.id);
        } else if (!room.hostPlayerId && bots.length > 0) {
            this.host.transferHost(room, bots[0].id);
        }

        if (humans.length === 0) {
            state.assistTarget = randomInRange(this.config.assistTargetPlayers, this.random);

            // start a fresh session once humans have left, so bot-only play never extends theirs
            const gameHadHumans = [...room.game.state.players.values()].some(player => !player.isBot);
            if (
                phase === "lobby" && bots.length > 0
                && (gameHadHumans || room.game.state.round >= this.config.maxBotOnlyRoundsPerSession)
            ) {
                this.host.resetGame(room);
            }

            if (state.background && now >= state.nextRetargetAt) {
                state.backgroundTarget = randomInRange(this.config.backgroundBotsPerRoom, this.random);
                state.nextRetargetAt = now + randomInRange(this.config.backgroundRetargetIntervalMs, this.random);
            }
        }

        this.adjustPopulation(room, state, now, {
            humansInRoom: humans.length,
            humansPresent,
            bots: bots.length,
        }, botsAllowed);

        if (
            botsAllowed && state.background && humans.length === 0 && room.game.state.phase === "lobby"
            && this.botsIn(room).length >= this.options.minPlayersToStart
            && now >= state.nextAutoRoundAt
        ) {
            state.nextAutoRoundAt = now + randomInRange(this.config.backgroundRoundIntervalMs, this.random);
            const hostBot = room.hostPlayerId ? room.players.get(room.hostPlayerId) : undefined;
            if (hostBot?.isBot && this.host.startRound(room, hostBot)) {
                console.log(`Room ${room.id}: bots started a round on their own`);
            }
        }
    }

    private adjustPopulation(
        room: Room,
        state: RoomBotState,
        now: number,
        counts: { humansInRoom: number; humansPresent: number; bots: number },
        botsAllowed: boolean,
    ): void {
        const desired = !botsAllowed ? 0 : desiredBotCount({
            ...counts,
            background: state.background,
            backgroundTarget: state.backgroundTarget,
            assistTarget: state.assistTarget,
            minPlayersToStart: this.options.minPlayersToStart,
            capacity: this.options.capacity,
        });
        const change = desired > counts.bots ? "add" : desired < counts.bots ? "remove" : null;

        if (change === null) state.assistJoins = 0;
        if (change !== state.pendingChange) {
            state.pendingChange = change;
            state.changeAt = change === null ? null : now + randomInRange(
                change === "remove" ? this.config.leaveGapMs
                    : counts.humansPresent > 0 && state.assistJoins === 0 ? this.config.assistDelayMs
                    : this.config.joinGapMs,
                this.random,
            );
        }

        // bots only come and go between rounds, so no round is ever left incomplete
        if (change === null || state.changeAt === null || now < state.changeAt) return;
        if (room.game.state.phase !== "lobby") return;
        if (change === "add" && room.locked) return;

        if (change === "add") {
            if (this.addBot(room) && counts.humansPresent > 0) state.assistJoins++;
        } else {
            this.removeBot(room);
        }
        // the next change waits for its own gap, one bot at a time
        state.pendingChange = null;
        state.changeAt = null;
    }

    private addBot(room: Room): boolean {
        if (room.players.size >= this.options.capacity) return false;

        const bot: Player = {
            id: `bot-${crypto.randomUUID()}`,
            token: crypto.randomUUID(), // never sent anywhere; bots have no socket
            socketId: "",
            name: generatePlayerName(this.host.usedNames()),
            connected: true,
            isBot: true,
        };
        this.host.addPlayer(room, bot);
        console.log(`Bot joined: ${bot.name} in room ${room.id}`);

        if (this.humanConnected(room)) this.maybeEmote(room, bot, "greeting");
        return true;
    }

    private removeBot(room: Room): void {
        const bots = this.botsIn(room);
        const nonHosts = bots.filter(bot => bot.id !== room.hostPlayerId);
        const bot = this.pick(nonHosts.length > 0 ? nonHosts : bots);
        if (!bot) return;

        console.log(`Bot left: ${bot.name} from room ${room.id}`);
        this.host.removePlayer(room, bot);
    }


    // ---- round actions ----

    private answer(room: Room, bot: Player): void {
        const game = room.game;
        const round = game.currentRound();
        if (!round || game.state.phase !== "answering" || room.players.get(bot.id) !== bot) return;

        const plans = this.states.get(room.id)?.plans;
        const plan = plans?.gameId === game.id && plans.round === game.state.round
            ? plans.byBot.get(bot.id)
            : undefined;
        const hand = round.wordsAvailable.get(bot.id) ?? [];
        const fallback = (): { words: string[]; origin: AnswerOrigin } => {
            // mark first: the submission saves the round straight away
            round.containsSyntheticAnswers = true;
            return { words: randomAnswer(hand, this.config.randomAnswerWords, this.random), origin: { provenance: "bot_random" } };
        };

        const chosen = plan ?? fallback();
        if (this.host.submitAnswer(room, bot, chosen.words, chosen.origin)) {
            this.maybeEmoteWhileWaiting(room, bot);
            return;
        }

        // only retry when the planned words were the problem, not the phase or a duplicate
        const stillExpected = game.state.phase === "answering"
            && game.currentRound() === round
            && room.activePlayerIds.has(bot.id)
            && !round.answers.some(answer => answer.playerId === bot.id);
        if (!plan || !stillExpected) return;

        const random = fallback();
        if (this.host.submitAnswer(room, bot, random.words, random.origin)) this.maybeEmoteWhileWaiting(room, bot);
    }

    /** A bot that has answered sometimes nudges the others while they are still building theirs. */
    private maybeEmoteWhileWaiting(room: Room, bot: Player): void {
        const state = this.states.get(room.id);
        if (!state || !this.humanConnected(room) || this.random() >= this.config.waitingEmoteChance) return;

        const game = room.game;
        const round = game.currentRound();
        this.scheduleEmote(room, state, this.config.waitingEmoteDelayMs, () => {
            const someoneStillAnswering = [...room.activePlayerIds].some(id =>
                !round?.answers.some(answer => answer.playerId === id),
            );
            if (
                room.game === game && game.currentRound() === round && game.state.phase === "answering"
                && room.players.get(bot.id) === bot && someoneStillAnswering
            ) {
                this.host.sendEmote(room, bot, this.pick(["impatience", "readiness"])!);
            }
        });
    }

    private rank(room: Room, bot: Player): void {
        const round = room.game.currentRound();
        if (!round || room.game.state.phase !== "ranking" || room.players.get(bot.id) !== bot) return;

        const answerIds = this.shuffled(
            round.answers.filter(answer => answer.playerId !== bot.id).map(answer => answer.id),
        );
        this.host.submitRanking(room, bot, answerIds);
    }

    private ready(room: Room, bot: Player): void {
        const round = room.game.currentRound();
        if (!round || room.game.state.phase !== "results" || room.players.get(bot.id) !== bot) return;

        if (this.humanConnected(room)) {
            const own = round.answers.find(answer => answer.playerId === bot.id);
            const best = Math.max(0, ...[...(round.scores?.values() ?? [])]);
            const score = own ? round.scores?.get(own.id) ?? 0 : 0;
            this.maybeEmote(room, bot, own && score === best && best > 0
                ? "boasting"
                : this.pick(["praise", "regret", "disbelief"])!);
        }
        this.host.readyForNextRound(room, bot);
    }


    // ---- helpers ----

    private state(room: Room): RoomBotState {
        let state = this.states.get(room.id);
        if (!state) {
            const now = this.now();
            state = {
                background: false,
                paused: false,
                hostDisabled: false,
                backgroundTarget: randomInRange(this.config.backgroundBotsPerRoom, this.random),
                assistTarget: randomInRange(this.config.assistTargetPlayers, this.random),
                nextRetargetAt: now + randomInRange(this.config.backgroundRetargetIntervalMs, this.random),
                // stagger the first autonomous rounds across rooms
                nextAutoRoundAt: now + Math.floor(this.random() * this.config.backgroundRoundIntervalMs.max),
                pendingChange: null,
                changeAt: null,
                assistJoins: 0,
                actions: new Map(),
                plans: null,
                emoteTimers: new Set(),
                greetingsBy: new Map(),
            };
            this.states.set(room.id, state);
        }
        return state;
    }

    private botsIn(room: Room): Player[] {
        return [...room.players.values()].filter(player => player.isBot);
    }

    private humanConnected(room: Room): boolean {
        return [...room.players.values()].some(player => !player.isBot && player.connected);
    }

    /** True once every human in the current step has acted, so bots should not keep them waiting. */
    private humansAreWaiting(room: Room): boolean {
        if (!this.humanConnected(room)) return false;

        const round = room.game.currentRound();
        const phase = room.game.state.phase;
        const humansInRound = [...room.players.values()].filter(player =>
            !player.isBot && room.activePlayerIds.has(player.id) && (player.connected || player.reconnecting),
        );
        return humansInRound.every(player =>
            phase === "answering" ? round?.answers.some(answer => answer.playerId === player.id)
            : phase === "ranking" ? round?.rankings.has(player.id)
            : phase === "results" ? room.readyPlayers.has(player.id)
            : false,
        );
    }

    private delayBeforeDeadline(room: Room, range: Range, now: number): number {
        const delay = randomInRange(range, this.random);
        if (room.stageEndsAt === null) return delay;
        return Math.max(0, Math.min(delay, room.stageEndsAt - now - this.config.deadlineSafetyMs));
    }

    private maybeEmote(room: Room, bot: Player, emoteId: string): void {
        if (this.random() < this.config.emoteChance) this.host.sendEmote(room, bot, emoteId);
    }

    private scheduleEmote(room: Room, state: RoomBotState, delay: Range, run: () => void): void {
        const timer = setTimeout(() => {
            state.emoteTimers.delete(timer);
            try {
                run();
            } catch (error) {
                console.error(`Bot emote failed in room ${room.id}:`, error);
            }
        }, randomInRange(delay, this.random));
        state.emoteTimers.add(timer);
    }

    private clearActions(state: RoomBotState): void {
        for (const action of state.actions.values()) clearTimeout(action.timer);
        state.actions.clear();
        for (const timer of state.emoteTimers) clearTimeout(timer);
        state.emoteTimers.clear();
    }

    private pick<T>(items: T[]): T | undefined {
        return items.length === 0 ? undefined : items[Math.floor(this.random() * items.length)];
    }

    private shuffled<T>(items: T[]): T[] {
        const copy = [...items];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }
}
