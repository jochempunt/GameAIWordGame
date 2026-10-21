import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { Game } from "./game.js";
import { finishPredictionReview, loadHumorPredictor, predictRound, startPredictionReview } from "./predictions.js";
import type { HumorPredictor, PredictionTask } from "./predictions.js";
import type { Player } from "./types.js";
import { viewForPlayer } from "./views.js";

const playerIds = ["one", "two", "three"];
function makeGame(): Game {
    const game = new Game("prediction-test");
    for (const id of playerIds) game.recordPlayer(id, id);
    assert.equal(game.startRound(playerIds), true);
    const round = game.currentRound()!;
    round.wordsAvailable = new Map(playerIds.map(id => [id, ["funny", "cat", "sleepy"]]));
    return game;
}

function submitAll(game: Game): void {
    for (const id of playerIds) assert.ok(game.submitAnswer(id, ["cat"]));
}

const model: HumorPredictor = {
    predictTask: task => task.inputs.candidates.map((candidate, index) => ({
        answer_id: candidate.answer_id, score: 3 - index,
    })),
};

test("all submissions trigger one prediction before player voting, without passing labels", () => {
    const game = makeGame();
    let calls = 0;
    let received: PredictionTask | undefined;
    const spy: HumorPredictor = { predictTask(task) { calls++; received = task; return model.predictTask(task); } };
    assert.ok(game.submitAnswer("one", ["cat"]));
    assert.equal(startPredictionReview(game, playerIds, spy, 1000), false);
    assert.equal(calls, 0);
    assert.ok(game.submitAnswer("two", ["cat"]));
    assert.ok(game.submitAnswer("three", ["cat"]));
    assert.equal(startPredictionReview(game, playerIds, spy, 1000), true);
    assert.equal(game.state.phase, "prediction");
    assert.equal(calls, 1);
    assert.equal(received!.inputs.candidates.length, 3);
    assert.deepEqual(Object.keys(received!), ["inputs"]);
    assert.deepEqual(Object.keys(received!.inputs).sort(), ["candidates", "prompt"]);
    for (const candidate of received!.inputs.candidates) {
        assert.deepEqual(Object.keys(candidate).sort(), ["answer_id", "answer_tokens", "available_words", "player_id"]);
    }
    assert.equal(startPredictionReview(game, playerIds, spy, 1000), false);
    assert.equal(calls, 1);
    assert.equal(game.submitAnswer("one", ["cat"]), undefined);

    assert.equal(game.currentRound()!.predictionEndsAt, 6000);
    assert.equal(finishPredictionReview(game, 5999), false);
    assert.equal(game.state.phase, "prediction");
    assert.equal(finishPredictionReview(game, 6000), true);
    assert.equal(game.state.phase, "ranking");
    assert.equal(finishPredictionReview(game, 6001), false);

    // Human ballots alone still determine points and totals.
    const round = game.currentRound()!;
    const answers = round.answers;
    for (const id of playerIds) round.rankings.set(id, {
        answerIds: [...answers].reverse().filter(answer => answer.playerId !== id).map(answer => answer.id),
        receivedAt: new Date(),
    });
    game.calculateScores();
    assert.equal(round.scores!.get(answers[2].id), 4);
    assert.equal(round.scores!.get(answers[0].id), 2);
    assert.equal(round.prediction!.answers.find(answer => answer.answerId === answers[0].id)!.rank, 1);
});

test("player views expose only their own position, including after reconnect", () => {
    const game = makeGame();
    submitAll(game);
    startPredictionReview(game, playerIds, model);
    const players: Player[] = playerIds.map(id => ({
        id, name: id, token: id, socketId: id, connected: true,
    }));
    const ready = new Set(["one"]);
    const view = viewForPlayer(game, players[0], players, ready, new Set(playerIds), "one", false);
    assert.equal(view.phase, "prediction");
    if (view.phase !== "prediction") throw new Error("Expected prediction view");
    assert.deepEqual(view.ownPrediction, { rank: 1, totalAnswers: 3 });
    assert.equal("predictions" in view, false);
    assert.equal("answers" in view, false);
    const secondView = viewForPlayer(game, players[1], players, ready, new Set(playerIds), "one", false);
    assert.equal(secondView.phase, "prediction");
    if (secondView.phase !== "prediction") throw new Error("Expected prediction view");
    assert.deepEqual(secondView.ownPrediction, { rank: 2, totalAnswers: 3 });
    const spectator: Player = { id: "spectator", name: "spectator", token: "spectator", socketId: "spectator", connected: true };
    const spectatorView = viewForPlayer(game, spectator, [...players, spectator], ready, new Set(playerIds), "one", false);
    assert.equal(spectatorView.phase, "prediction");
    if (spectatorView.phase !== "prediction") throw new Error("Expected prediction view");
    assert.equal(spectatorView.ownPrediction, null);
    assert.equal("predictions" in spectatorView, false);
});

test("automatic transition requires no player readiness or connection", () => {
    const game = makeGame();
    submitAll(game);
    startPredictionReview(game, playerIds, model, 1000);
    assert.equal(finishPredictionReview(game, 6000), true);
});

test("unavailable or broken models leave a review that can continue to human voting", () => {
    for (const broken of [null, { predictTask() { throw new Error("broken"); } },
        { predictTask() { return [{ answer_id: "unknown", score: NaN }]; } }]) {
        const game = makeGame();
        submitAll(game);
        assert.equal(startPredictionReview(game, playerIds, broken, 1000), true);
        assert.deepEqual(game.currentRound()!.prediction, { status: "unavailable", answers: [] });
        assert.equal(finishPredictionReview(game, 6000), true);
    }
});

test("equal model scores receive equal predicted ranks", () => {
    const game = makeGame();
    submitAll(game);
    const tied = { predictTask: (task: PredictionTask) => task.inputs.candidates.map((candidate, index) => ({
        answer_id: candidate.answer_id, score: index < 2 ? 2 : 1,
    })) };
    assert.deepEqual(predictRound(game.currentRound()!, tied).answers.map(answer => answer.rank), [1, 1, 3]);
});

test("local trained model scores a complete live round", {
    skip: !existsSync(new URL("../ml/humor/artifacts/model/humor_ranker.cjs", import.meta.url)),
}, () => {
    const game = makeGame();
    submitAll(game);
    const loaded = loadHumorPredictor();
    assert.ok(loaded);
    const prediction = predictRound(game.currentRound()!, loaded);
    assert.equal(prediction.status, "ready");
    assert.equal(prediction.answers.length, 3);
    assert.ok(prediction.answers.every(answer => Number.isFinite(answer.score)));
});
