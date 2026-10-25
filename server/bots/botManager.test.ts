import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../game.js";
import { BotManager } from "./botManager.js";
import type { BotHost } from "./botManager.js";
import { PregeneratedPool, ReusableAnswerPool } from "./answerSources.js";
import type { ReusableAnswer } from "./answerSources.js";
import { parseBotSettings } from "./botSettings.js";
import type { BotSettings } from "./botSettings.js";
import { preferredHost } from "./population.js";
import { PROMPTS } from "../prompts.js";
import type { Player, Room } from "../types.js";

const fixed = (ms: number) => ({ min: ms, max: ms });

const CONFIG: BotSettings = parseBotSettings({
    enabled: true,
    backgroundRooms: fixed(1),
    backgroundBotsPerRoom: fixed(4),
    backgroundRoundIntervalMs: fixed(60_000),
    backgroundRetargetIntervalMs: fixed(10_000_000),
    maxBotOnlyRoundsPerSession: 20,
    assistTargetPlayers: fixed(3),
    assistDelayMs: fixed(20_000),
    joinGapMs: fixed(10_000),
    leaveGapMs: fixed(15_000),
    answerDelayMs: fixed(5_000),
    rankingDelayMs: fixed(5_000),
    readyDelayMs: fixed(5_000),
    catchUpDelayMs: fixed(1_000),
    deadlineSafetyMs: 1_000,
    randomAnswerWords: { min: 2, max: 3 },
    reusedAnswerChance: 1,
    pregeneratedAnswerChance: 1,
    reuseCooldownMs: 0,
    minReusableAnswerWords: 1,
    emoteChance: 0,
    greetingReplyChance: 0.3,
    greetingReplyDecay: 0.5,
    waitingEmoteChance: 0,
    emoteReplyDelayMs: fixed(2_000),
    waitingEmoteDelayMs: fixed(5_000),
});

function newRoom(id: string): Room {
    return {
        id,
        game: new Game(),
        players: new Map(),
        readyPlayers: new Set(),
        activePlayerIds: new Set(),
        hostPlayerId: null,
        locked: false,
        stageTimer: null,
        stageEndsAt: null,
    };
}

function human(id: string): Player {
    return { id, token: id, socketId: id, name: id, connected: true };
}

/** Just enough of the server's room handling to drive the manager. */
function setup(
    roomCount = 1,
    config: BotSettings = CONFIG,
    reusable = new ReusableAnswerPool(),
    random: () => number = Math.random,
) {
    const emotes: { roomId: string; playerId: string; emoteId: string }[] = [];
    const rooms = Array.from({ length: roomCount }, (_, index) => newRoom(`R${index}`));
    let clock = 0;
    const host: BotHost = {
        rooms: () => rooms,
        usedNames: () => new Set(rooms.flatMap(room => [...room.players.values()].map(p => p.name.toLowerCase()))),
        addPlayer: (room, player) => join(room, player),
        removePlayer: (room, player) => {
            room.players.delete(player.id);
            room.activePlayerIds.delete(player.id);
            if (room.hostPlayerId === player.id) room.hostPlayerId = preferredHost(room.players.values())?.id ?? null;
        },
        transferHost: (room, playerId) => { room.hostPlayerId = playerId; },
        startRound: (room, player) => {
            if (room.hostPlayerId !== player.id) return false;
            room.activePlayerIds = new Set([...room.players.values()].filter(p => p.connected).map(p => p.id));
            if (!room.game.startRound([...room.activePlayerIds])) return false;
            manager.onRoundStarted(room);
            return true;
        },
        submitAnswer: (room, player, words, origin) => room.game.submitAnswer(player.id, words, origin) !== undefined,
        submitRanking: () => true,
        readyForNextRound: () => true,
        resetGame: room => {
            room.game = new Game();
            for (const player of room.players.values()) room.game.recordPlayer(player.id, player.name, player.isBot === true);
        },
        sendEmote: (room, player, emoteId) => { emotes.push({ roomId: room.id, playerId: player.id, emoteId }); },
    };
    const join = (room: Room, player: Player) => {
        room.players.set(player.id, player);
        room.game.recordPlayer(player.id, player.name, player.isBot === true);
        if (room.game.state.phase === "lobby") room.activePlayerIds.add(player.id);
        if (!room.hostPlayerId) room.hostPlayerId = player.id;
    };
    const manager = new BotManager(host, {
        config,
        minPlayersToStart: 3,
        capacity: 20,
        pregenerated: new PregeneratedPool(new Map(PROMPTS.map(prompt => [prompt, [["the", "cat"], ["oops"]]])), []),
        reusable,
        now: () => clock,
        random,
    });
    managers.push(manager);

    const bots = (room: Room) => [...room.players.values()].filter(p => p.isBot);
    const advance = (ms: number) => {
        for (let step = 0; step < ms; step += 1_000) {
            clock += 1_000;
            manager.tick(clock);
        }
    };
    return { rooms, manager, join, bots, advance, emotes };
}

const managers: BotManager[] = [];
afterEach(() => {
    for (const manager of managers.splice(0)) manager.stop();
});

test("background rooms start populated with bots and a bot host", () => {
    const { rooms, manager, bots } = setup(3);
    manager.start();

    const populated = rooms.filter(room => bots(room).length > 0);
    assert.equal(populated.length, 1);
    assert.equal(bots(populated[0]).length, 4);
    assert.equal(populated[0].players.get(populated[0].hostPlayerId!)?.isBot, true);
});

test("bot-only background rooms occasionally start a round on their own", () => {
    const { rooms, manager, advance } = setup(1);
    manager.start();
    const [room] = rooms;

    advance(61_000);
    assert.equal(room.game.state.phase, "answering");
    assert.ok(room.game.currentRound()?.botPlayerIds?.length === 4);
});

test("a human joining a bot-hosted room becomes host immediately", () => {
    const { rooms, manager, join, advance } = setup(1);
    manager.start();
    const [room] = rooms;

    join(room, human("alice"));
    advance(1_000);
    assert.equal(room.hostPlayerId, "alice");

    // no autonomous rounds while a human is in the room
    advance(120_000);
    assert.equal(room.game.state.phase, "lobby");
});

test("bots join a lone human gradually, one at a time, after a wait", () => {
    const { rooms, join, bots, advance } = setup(1, { ...CONFIG, backgroundRooms: fixed(0) });
    const [room] = rooms;
    join(room, human("alice"));

    advance(19_000);
    assert.equal(bots(room).length, 0, "no bot before the assist delay");
    advance(2_000);
    assert.equal(bots(room).length, 1);
    advance(8_000);
    assert.equal(bots(room).length, 1, "the next bot waits for its own gap");
    advance(3_000);
    assert.equal(bots(room).length, 2);
    advance(60_000);
    assert.equal(bots(room).length, 2, "two bots are enough for one human");
    assert.equal(room.hostPlayerId, "alice");
});

test("bots leave as humans arrive, but never during a round", () => {
    const { rooms, join, bots, advance } = setup(1, { ...CONFIG, backgroundRooms: fixed(0) });
    const [room] = rooms;
    join(room, human("alice"));
    advance(40_000);
    assert.equal(bots(room).length, 2);

    join(room, human("bob"));
    join(room, human("carol"));
    room.activePlayerIds = new Set(room.players.keys());
    room.game.startRound([...room.activePlayerIds]);

    advance(120_000);
    assert.equal(bots(room).length, 2, "bots stay until the round is over");

    room.game.state.phase = "lobby";
    advance(16_000);
    assert.equal(bots(room).length, 1);
    advance(16_000);
    assert.equal(bots(room).length, 0);
});

test("bots stay when removing them would stop the remaining humans from playing", () => {
    const { rooms, join, bots, advance } = setup(1, { ...CONFIG, backgroundRooms: fixed(0) });
    const [room] = rooms;
    join(room, human("alice"));
    join(room, human("bob"));
    advance(30_000);
    assert.equal(bots(room).length, 1);
    advance(300_000);
    assert.equal(bots(room).length, 1);
});

test("a bot sometimes greets back after a delay, less likely with each greeting from the same human", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
        // 0.2 is below the first chance (0.3) but above the second (0.15)
        const { rooms, manager, join, advance, emotes } = setup(1, { ...CONFIG, backgroundRooms: fixed(0) }, undefined, () => 0.2);
        const [room] = rooms;
        const alice = human("alice");
        join(room, alice);
        join(room, { ...human("bot-a"), isBot: true });
        advance(1_000);

        manager.onPlayerEmote(room, alice, "greeting");
        mock.timers.tick(1_999);
        assert.equal(emotes.length, 0, "the reply waits a moment");
        mock.timers.tick(1);
        assert.deepEqual(emotes, [{ roomId: room.id, playerId: "bot-a", emoteId: "greeting" }]);

        manager.onPlayerEmote(room, alice, "greeting");
        manager.onPlayerEmote(room, alice, "praise");
        mock.timers.tick(10_000);
        assert.equal(emotes.length, 1, "a second greeting has only half the chance, and other emotes get no reply");

        // a different human starts again at the full chance
        manager.onPlayerEmote(room, human("bob"), "greeting");
        mock.timers.tick(2_000);
        assert.equal(emotes.length, 2);
    } finally {
        mock.timers.reset();
    }
});

test("paused bots leave between rounds and stop starting rounds, globally or per room", () => {
    const { rooms, manager, bots, advance } = setup(2, { ...CONFIG, backgroundRooms: fixed(2) });
    manager.start();
    assert.ok(rooms.every(room => bots(room).length === 4));

    manager.setPaused(true, rooms[0]);
    assert.equal(manager.isPaused(rooms[0].id), true);
    assert.equal(manager.isPaused(), false);
    advance(16_000 * 5);
    assert.equal(bots(rooms[0]).length, 0);
    assert.equal(rooms[0].game.state.phase, "lobby");
    assert.ok(bots(rooms[1]).length > 0, "the other room keeps its bots");

    manager.setPaused(false, rooms[0]);
    manager.setPaused(true);
    // the fake host never finishes rounds, so end one the bots may have started meanwhile
    rooms[1].game.state.phase = "lobby";
    advance(16_000 * 5);
    assert.equal(bots(rooms[1]).length, 0);
    assert.equal(bots(rooms[0]).length, 0, "the global pause also covers resumed rooms");
});

test("bots in a round get playable planned answers and never reuse a present human's answer", () => {
    const reusable = new ReusableAnswerPool();
    const answers: ReusableAnswer[] = PROMPTS.flatMap(prompt => ["alice", "zed"].map(authorId => ({
        id: `${authorId}:${prompt}`, prompt, words: ["my", "dog", authorId === "alice" ? "ate" : "lied"],
        authorId, sourceGameId: "old", sourceRoundNumber: 1, sourceRoundId: "old:1",
        sourceAnswerId: "a", collectedAt: new Date(0), usageCount: 0, lastUsedAt: null,
    })));
    reusable.load(answers);

    const { rooms, manager, join, bots, advance } = setup(1, { ...CONFIG, backgroundRooms: fixed(0) }, reusable);
    const [room] = rooms;
    join(room, human("alice"));
    advance(40_000);
    assert.equal(bots(room).length, 2);

    const alice = room.players.get("alice")!;
    assert.ok(manager["host"].startRound(room, alice));
    const round = room.game.currentRound()!;
    for (const bot of bots(room)) {
        manager["answer"](room, bot);
    }

    const botAnswers = round.answers.filter(answer => room.game.isBot(answer.playerId));
    assert.equal(botAnswers.length, 2);
    // only one answer by someone outside the room exists, so one bot reuses it and the other cannot
    const reused = botAnswers.filter(answer => answer.provenance === "bot_reused_human");
    assert.equal(reused.length, 1);
    assert.equal(reused[0].reusedFrom?.originalAuthorId, "zed");
    assert.ok(botAnswers.every(answer => answer.reusedFrom?.originalAuthorId !== "alice"));
    assert.equal(round.containsSyntheticAnswers, true);
});
