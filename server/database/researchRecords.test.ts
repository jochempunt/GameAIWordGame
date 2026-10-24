import { test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../game.js";
import { buildGameRecords, classifyRound, collectReusableAnswers } from "./researchRecords.js";
import type { AnswerOrigin } from "../types.js";

const REUSED: AnswerOrigin = {
    provenance: "bot_reused_human",
    reusedFrom: { reusableAnswerId: "reusable-1", originalAuthorId: "old-human", originalRoundId: "old-game:3" },
};

function newGame(players: { id: string; bot?: boolean }[]): Game {
    const game = new Game("game-1");
    for (const { id, bot } of players) game.recordPlayer(id, id, bot);
    return game;
}

/** Plays one round: everyone answers (bots with the given origin) and ranks the others. */
function playRound(game: Game, playerIds: string[], botOrigins: Record<string, AnswerOrigin> = {}): number {
    game.state.phase = "lobby";
    assert.ok(game.startRound(playerIds));
    const round = game.currentRound()!;

    for (const id of playerIds) {
        const origin = botOrigins[id];
        if (origin) {
            const words = ["the", "cat", "did", "it"];
            assert.ok(game.redealHand(id, words));
            assert.ok(game.submitAnswer(id, words, origin));
        } else {
            assert.ok(game.submitAnswer(id, round.wordsAvailable.get(id)!.slice(0, 3)));
        }
    }
    game.state.phase = "ranking";
    for (const id of playerIds) {
        round.rankings.set(id, {
            answerIds: round.answers.filter(answer => answer.playerId !== id).map(answer => answer.id),
            receivedAt: new Date(),
            ...(game.isBot(id) ? { isBot: true as const } : {}),
        });
    }

    game.calculateScores();
    for (const answer of round.answers) {
        game.state.totals.set(answer.playerId, (game.state.totals.get(answer.playerId) ?? 0) + round.scores!.get(answer.id)!);
    }
    round.status = "completed";
    round.completedAt = new Date();
    game.state.phase = "results";
    return game.state.round;
}

test("fully human rounds keep the existing stored shape", () => {
    const game = newGame([{ id: "h1" }, { id: "h2" }, { id: "h3" }]);
    playRound(game, ["h1", "h2", "h3"]);

    const { game: stored, syntheticRounds } = buildGameRecords(game, "AAAA");
    assert.ok(stored);
    assert.deepEqual(syntheticRounds, []);
    assert.equal("excludedRounds" in stored, false);
    assert.deepEqual(stored.state.players.map(player => Object.keys(player).sort()), [
        ["joinedAt", "name", "playerId"], ["joinedAt", "name", "playerId"], ["joinedAt", "name", "playerId"],
    ]);

    const [round] = stored.state.rounds;
    assert.deepEqual(Object.keys(round).sort(), [
        "answers", "completedAt", "playerIds", "prompt", "rankings", "roundNumber",
        "scores", "startedAt", "status", "wordsAvailable",
    ]);
    assert.deepEqual(Object.keys(round.answers[0]).sort(), ["answerId", "playerId", "receivedAt", "words"]);
    assert.deepEqual(Object.keys(round.rankings[0]).sort(), ["answerIds", "playerId", "receivedAt"]);
    assert.deepEqual(stored.state.totals, [...game.state.totals].map(([playerId, score]) => ({ playerId, score })));
});

test("a round with a pre-generated or random bot answer is excluded and stored separately", () => {
    const game = newGame([{ id: "h1" }, { id: "h2" }, { id: "h3" }, { id: "bot", bot: true }]);
    playRound(game, ["h1", "h2", "h3"]);
    const synthetic = playRound(game, ["h1", "h2", "bot"], { bot: { provenance: "bot_pregenerated" } });
    assert.equal(classifyRound(game.state.rounds.get(synthetic)!), "synthetic");

    const { game: stored, syntheticRounds } = buildGameRecords(game, "AAAA");
    assert.ok(stored);
    assert.deepEqual(stored.state.rounds.map(round => round.roundNumber), [1]);
    assert.deepEqual(stored.excludedRounds, [{ roundNumber: 2, reason: "synthetic_bot_answers" }]);
    // totals only reflect the stored research round
    const roundOneScores = stored.state.rounds[0].scores!;
    assert.equal(
        stored.state.totals.reduce((sum, total) => sum + total.score, 0),
        roundOneScores.reduce((sum, score) => sum + score.score, 0),
    );

    assert.equal(syntheticRounds.length, 1);
    const [excluded] = syntheticRounds;
    assert.equal(excluded._id, "game-1:2");
    assert.deepEqual(excluded.research, { botAssisted: true, eligible: false, reason: "synthetic_bot_answers" });
    assert.deepEqual(
        Object.fromEntries(excluded.answers.map(answer => [answer.playerId, answer.provenance])),
        { h1: "human_original", h2: "human_original", bot: "bot_pregenerated" },
    );
    assert.deepEqual(
        Object.fromEntries(excluded.rankings.map(ranking => [ranking.playerId, ranking.isBot])),
        { h1: false, h2: false, bot: true },
    );
    assert.equal(excluded.players.find(player => player.playerId === "bot")?.isBot, true);
});

test("a planned synthetic answer excludes the round before the bot has submitted it", () => {
    const game = newGame([{ id: "h1" }, { id: "h2" }, { id: "bot", bot: true }]);
    game.startRound(["h1", "h2", "bot"]);
    game.currentRound()!.containsSyntheticAnswers = true;
    game.submitAnswer("h1", game.currentRound()!.wordsAvailable.get("h1")!.slice(0, 2));

    const { game: stored, syntheticRounds } = buildGameRecords(game);
    assert.equal(stored, null);
    assert.equal(syntheticRounds.length, 1);
});

test("a round where bots only reuse human answers stays a research round with provenance", () => {
    const game = newGame([{ id: "h1" }, { id: "h2" }, { id: "bot", bot: true }]);
    playRound(game, ["h1", "h2", "bot"], { bot: REUSED });

    const { game: stored, syntheticRounds } = buildGameRecords(game);
    assert.ok(stored);
    assert.deepEqual(syntheticRounds, []);
    const [round] = stored.state.rounds;
    assert.deepEqual(round.research, { botAssisted: true, eligible: true });
    assert.deepEqual(round.botPlayerIds, ["bot"]);

    const botAnswer = round.answers.find(answer => answer.playerId === "bot")!;
    assert.equal(botAnswer.provenance, "bot_reused_human");
    assert.deepEqual(botAnswer.reusedFrom, REUSED.reusedFrom);
    assert.equal(round.answers.find(answer => answer.playerId === "h1")!.provenance, "human_original");
    assert.equal(round.rankings.find(ranking => ranking.playerId === "bot")!.isBot, true);
    assert.equal(round.rankings.find(ranking => ranking.playerId === "h2")!.isBot, false);
    assert.equal(stored.state.players.find(player => player.playerId === "bot")!.isBot, true);
});

test("rounds without humans are not stored anywhere", () => {
    const game = newGame([{ id: "b1", bot: true }, { id: "b2", bot: true }, { id: "b3", bot: true }]);
    playRound(game, ["b1", "b2", "b3"], {
        b1: { provenance: "bot_random" }, b2: { provenance: "bot_pregenerated" }, b3: { provenance: "bot_random" },
    });

    assert.deepEqual(buildGameRecords(game), { game: null, syntheticRounds: [] });
});

test("original human answers from bot-assisted rounds are collected with attribution", () => {
    const game = newGame([{ id: "h1" }, { id: "h2" }, { id: "h3" }, { id: "bot", bot: true }]);
    const humanOnly = playRound(game, ["h1", "h2", "h3"]);
    const synthetic = playRound(game, ["h1", "h2", "bot"], { bot: { provenance: "bot_random" } });
    const reused = playRound(game, ["h1", "h2", "bot"], { bot: REUSED });

    assert.deepEqual(collectReusableAnswers(game, humanOnly, 1), []);

    const collected = collectReusableAnswers(game, synthetic, 1, new Date(42));
    assert.deepEqual(collected.map(answer => answer.authorId).sort(), ["h1", "h2"]);
    const h1 = collected.find(answer => answer.authorId === "h1")!;
    const round = game.state.rounds.get(synthetic)!;
    assert.deepEqual(h1.words, round.answers.find(answer => answer.playerId === "h1")!.words);
    assert.equal(h1.prompt, round.prompt);
    assert.equal(h1.sourceRoundId, `game-1:${synthetic}`);
    assert.deepEqual(h1.collectedAt, new Date(42));

    // reused answers are not collected again as if they were new human answers
    assert.deepEqual(collectReusableAnswers(game, reused, 1).map(answer => answer.authorId).sort(), ["h1", "h2"]);
    // the id identifies author, prompt and words, so collecting twice yields the same entries
    assert.deepEqual(
        collectReusableAnswers(game, synthetic, 1).map(answer => answer.id),
        collected.map(answer => answer.id),
    );
    assert.deepEqual(collectReusableAnswers(game, synthetic, 4), []);
});
