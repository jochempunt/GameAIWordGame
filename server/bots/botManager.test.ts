import { afterEach, test } from "node:test";
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
function setup(roomCount = 1, config: BotSettings = CONFIG, reusable = new ReusableAnswerPool()) {
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
        sendEmote: () => undefined,
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
    });
    managers.push(manager);

    const bots = (room: Room) => [...room.players.values()].filter(p => p.isBot);
    const advance = (ms: number) => {
        for (let step = 0; step < ms; step += 1_000) {
            clock += 1_000;
            manager.tick(clock);
        }
    };
    return { rooms, manager, join, bots, advance };
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
