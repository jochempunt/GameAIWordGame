import { test } from "node:test";
import assert from "node:assert/strict";
import { countVisitors, parseAdminIds, playerIdForToken, summarizeRoomForAdmin } from "./admin.js";
import { Game } from "./game.js";
import type { Player, Room } from "./types.js";

const TOKEN = "3f2b8c1e-9a4d-4f6b-8e2a-1c5d7e9f0a3b";

function player(id: string, extra: Partial<Player> = {}): Player {
    return { id, token: id, socketId: id, name: id, connected: true, ...extra };
}

function room(players: Player[]): Room {
    const game = new Game("game");
    for (const p of players) game.recordPlayer(p.id, p.name, p.isBot === true);
    return {
        id: "AAAA",
        game,
        players: new Map(players.map(p => [p.id, p])),
        readyPlayers: new Set(),
        activePlayerIds: new Set(players.map(p => p.id)),
        hostPlayerId: players[0]?.id ?? null,
        locked: false,
        stageTimer: null,
        stageEndsAt: null,
    };
}

test("admin ids accept session tokens (hashed) and participant ids", () => {
    const participantId = "a".repeat(64);
    const { ids, invalid } = parseAdminIds(` ${TOKEN.toUpperCase()}, ${participantId}\nnot-an-id `);

    assert.deepEqual([...ids].sort(), [playerIdForToken(TOKEN), participantId].sort());
    assert.deepEqual(invalid, ["not-an-id"]);
    // the raw token is never kept, so the configured set cannot be used to log in
    assert.equal(ids.has(TOKEN), false);
});

test("no configuration means no admins", () => {
    assert.equal(parseAdminIds(undefined).ids.size, 0);
    assert.equal(parseAdminIds("").ids.size, 0);
});

test("the admin room summary tells bots from humans and shows answer provenance", () => {
    const r = room([player("alice"), player("bot-1", { isBot: true }), player("bob")]);
    r.game.startRound(["alice", "bot-1", "bob"]);
    r.game.state.phase = "answering";
    const round = r.game.currentRound()!;
    r.game.submitAnswer("alice", round.wordsAvailable.get("alice")!.slice(0, 2));
    r.game.redealHand("bot-1", ["the", "cat"]);
    r.game.submitAnswer("bot-1", ["the", "cat"], { provenance: "bot_pregenerated" });

    const summary = summarizeRoomForAdmin(r, { background: false, botsPaused: false, spectators: 1 });
    assert.deepEqual(summary.players.map(p => [p.id, p.isBot, p.isHost, p.answered]), [
        ["alice", false, true, true],
        ["bot-1", true, false, true],
        ["bob", false, false, false],
    ]);
    assert.deepEqual(summary.answers.map(a => [a.playerId, a.provenance]), [
        ["alice", "human_original"],
        ["bot-1", "bot_pregenerated"],
    ]);
    assert.equal(summary.prompt, round.prompt);
    assert.equal(summary.spectators, 1);
});

test("site totals count participants in and outside rooms, without double counting tabs", () => {
    const r = room([player("alice"), player("away", { connected: false }), player("bot-1", { isBot: true })]);
    const connections = [
        { consentedPlayerId: "alice" },
        { consentedPlayerId: "alice" }, // second tab
        { consentedPlayerId: "browsing" },
        { consentedPlayerId: "admin" },
        {}, // still on the consent screen
    ];

    assert.deepEqual(countVisitors(connections, [r], new Set(["admin"])), {
        visitors: 5,
        online: 3,
        inRooms: 1,
        browsing: 2,
        bots: 1,
        admins: 1,
    });
});
