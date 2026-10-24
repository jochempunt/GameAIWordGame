import { test } from "node:test";
import assert from "node:assert/strict";
import { desiredBotCount, preferredHost, shouldHandHostToHuman } from "./population.js";
import type { Player } from "../types.js";

const base = {
    humansInRoom: 0,
    humansPresent: 0,
    bots: 0,
    background: false,
    backgroundTarget: 4,
    assistTarget: 3,
    minPlayersToStart: 3,
    capacity: 20,
};

function player(id: string, extra: Partial<Player> = {}): Player {
    return { id, token: id, socketId: id, name: id, connected: true, ...extra };
}

test("background rooms keep their bot population while no human is around", () => {
    assert.equal(desiredBotCount({ ...base, background: true }), 4);
    assert.equal(desiredBotCount({ ...base, background: false, bots: 2 }), 0);
});

test("bots fill up to a playable room for one or two humans", () => {
    assert.equal(desiredBotCount({ ...base, humansInRoom: 1, humansPresent: 1 }), 2);
    assert.equal(desiredBotCount({ ...base, humansInRoom: 2, humansPresent: 2 }), 1);
    assert.equal(desiredBotCount({ ...base, humansInRoom: 1, humansPresent: 1, assistTarget: 4 }), 3);
    // never below what the humans need to start, even with a low target
    assert.equal(desiredBotCount({ ...base, humansInRoom: 2, humansPresent: 2, assistTarget: 1 }), 1);
});

test("all bots leave once enough humans are present", () => {
    assert.equal(desiredBotCount({ ...base, humansInRoom: 3, humansPresent: 3, bots: 2 }), 0);
    assert.equal(desiredBotCount({ ...base, humansInRoom: 5, humansPresent: 5, bots: 4, background: true }), 0);
});

test("background bots shrink towards the assist target when a human arrives", () => {
    assert.equal(desiredBotCount({ ...base, humansInRoom: 1, humansPresent: 1, bots: 5, background: true }), 2);
});

test("population holds while every human is temporarily away", () => {
    assert.equal(desiredBotCount({ ...base, humansInRoom: 1, humansPresent: 0, bots: 2 }), 2);
});

test("host preference: a connected human beats any bot", () => {
    const bot = player("bot", { isBot: true });
    const human = player("human");
    assert.equal(preferredHost([bot, human])?.id, "human");
    assert.equal(preferredHost([bot, player("away", { connected: false })])?.id, "bot");
    assert.equal(preferredHost([player("away", { connected: false })]), undefined);
});

test("a bot host hands over to a human as soon as one is connected", () => {
    const bot = player("bot", { isBot: true });
    const human = player("human");
    const players = new Map([[bot.id, bot], [human.id, human]]);

    assert.equal(shouldHandHostToHuman("bot", players)?.id, "human");
    assert.equal(shouldHandHostToHuman(null, players)?.id, "human");
    assert.equal(shouldHandHostToHuman("human", players), undefined);

    // a disconnected human host keeps the seat during the reconnect grace
    const away = player("away", { connected: false, reconnecting: true });
    assert.equal(shouldHandHostToHuman("away", new Map([[away.id, away], [human.id, human]])), undefined);
});
