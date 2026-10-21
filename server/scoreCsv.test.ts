import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildScoreCsv, ScoreCsvLog } from "./scoreCsv.js";
import type { ScoreGame, ScoreRound } from "./scoreCsv.js";

function round(number = 1, scores = [4, 3, 2], predictions: number[] | null = [3, 2, 1]): ScoreRound {
    const ids = ["one", "two", "three"];
    return {
        roundNumber: number, status: "completed", prompt: "Funny cats",
        completedAt: new Date(Date.UTC(2026, 9, 21, 10, number)),
        answers: ids.map((playerId, index) => ({ answerId: `${number}-${index}`, playerId, words: ["funny", "cat"] })),
        scores: scores.map((score, index) => ({ answerId: `${number}-${index}`, score })),
        prediction: predictions ? { status: "ready", answers: predictions.map((score, index) => ({
            answerId: `${number}-${index}`, score, rank: index + 1,
        })) } : undefined,
    };
}
function game(id = "game-one", rounds = [round()]): ScoreGame {
    return { _id: id, roomId: "AAAA", state: {
        players: ["one", "two", "three"].map(playerId => ({ playerId, name: playerId })), rounds,
    } };
}
// Numeric/identifier fixtures contain no quoted fields. Escaping is checked separately below.
function records(contents: string): Record<string, string>[] {
    const [header, ...rows] = contents.trimEnd().split("\r\n");
    const columns = header.split(",");
    return rows.map(row => Object.fromEntries(row.split(",").map((value, index) => [columns[index], value])));
}

test("player totals and model accuracy accumulate across completed rounds and games", () => {
    const first = game("first", [round(), round(2, [2, 4, 3])]);
    const second = game("second", [round(3)]);
    const output = buildScoreCsv([second, first]);
    const scores = records(output.scores);
    assert.equal(scores.length, 9);
    assert.equal(scores[3].game_total, "6");
    assert.equal(scores[6].game_total, "4");
    assert.equal(scores[6].all_games_total, "10");
    assert.equal(scores[7].all_games_total, "10");
    assert.equal(scores[8].all_games_total, "7");
    assert.equal(scores[3].human_rank, "3");
    const accuracy = records(output.accuracy);
    assert.equal(accuracy.length, 3);
    assert.equal(Number(accuracy[0].ndcg_at_3), 1);
    assert.equal(Number(accuracy[1].pairwise_accuracy), 1 / 3);
    assert.equal(Number(accuracy[1].cumulative_pairwise_accuracy), 2 / 3);
    assert.equal(Number(accuracy[1].cumulative_top1_accuracy), 0.5);
    assert.equal(accuracy[2].completed_rounds, "3");
    assert.equal(accuracy[2].evaluated_rounds, "3");
});

test("rounds without predictions count toward player totals but not AI evaluation", () => {
    const output = buildScoreCsv([game("game", [round(1, [4, 3, 2], null), round(2)])]);
    const scores = records(output.scores);
    assert.equal(scores[0].ai_rank, "");
    assert.equal(scores[0].ai_score, "");
    assert.equal(scores[3].game_total, "8");
    const accuracy = records(output.accuracy);
    assert.equal(accuracy[0].has_prediction, "0");
    assert.equal(accuracy[0].ndcg_at_3, "");
    assert.equal(accuracy[0].cumulative_top1_accuracy, "");
    assert.equal(accuracy[1].evaluated_rounds, "1");
    assert.equal(accuracy[1].cumulative_top1_accuracy, "1");
});

test("human ties stay tied and tied AI predictions receive order-independent credit", () => {
    const tied = buildScoreCsv([game("tie", [round(1, [4, 4, 2])])]);
    assert.deepEqual(records(tied.scores).map(row => row.human_rank), ["1", "1", "3"]);
    assert.equal(records(tied.accuracy)[0].pairwise_accuracy, "1");
    const ambiguous = round(1, [4, 3, 2], [1, 1, 1]);
    const original = buildScoreCsv([game("tie", [ambiguous])]);
    assert.deepEqual(records(original.scores).map(row => row.ai_rank), ["1", "1", "1"]);
    const metrics = records(original.accuracy)[0];
    assert.equal(Number(metrics.top1_accuracy), 1 / 3);
    assert.equal(Number(metrics.pairwise_accuracy), 0.5);
    ambiguous.answers.reverse();
    assert.equal(buildScoreCsv([game("tie", [ambiguous])]).accuracy, original.accuracy);
    const allTied = records(buildScoreCsv([game("tie", [round(1, [3, 3, 3])])]).accuracy)[0];
    assert.equal(allTied.pairwise_accuracy, "");
});

test("unfinished rounds, missing final scores, and duplicate snapshots never inflate totals", () => {
    const playing = round(2);
    playing.status = "in_progress";
    const abandoned = round(3);
    abandoned.status = "abandoned";
    const missing = round(4);
    delete missing.scores;
    const snapshot = game("saved", [round(), playing, abandoned, missing]);
    const output = buildScoreCsv([snapshot, snapshot]);
    assert.equal(records(output.scores).length, 3);
    assert.equal(records(output.accuracy).length, 1);
});

test("CSV correctly quotes commas, quotes, newlines, and Unicode", () => {
    const snapshot = game();
    snapshot.state.rounds[0].prompt = 'A "funny",\ncat 🐈';
    snapshot.state.players![0].name = 'Someone, "new"';
    const output = buildScoreCsv([snapshot]).scores;
    assert.ok(output.includes('"A ""funny"",\ncat 🐈"'));
    assert.ok(output.includes('"Someone, ""new"""'));
});

test("CSV refreshes are serialized and restarts rebuild identical logs without duplicate rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "round-csv-"));
    let active = 0, maxActive = 0;
    const snapshot = [game()];
    const log = new ScoreCsvLog(async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        return snapshot;
    }, directory);
    try {
        await Promise.all([log.refresh(), log.refresh()]);
        await log.flush();
        assert.equal(maxActive, 1);
        const original = await readFile(join(directory, "round-scores.csv"), "utf8");
        assert.equal(records(original).length, 3);
        const restarted = new ScoreCsvLog(async () => snapshot, directory);
        await restarted.refresh();
        assert.equal(await readFile(join(directory, "round-scores.csv"), "utf8"), original);
        snapshot[0].state.rounds.push(round(2));
        await restarted.refresh();
        assert.equal(records(await readFile(join(directory, "round-scores.csv"), "utf8")).length, 6);
        assert.deepEqual((await readdir(directory)).sort(), ["model-accuracy.csv", "round-scores.csv"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed snapshots preserve previous CSVs and a later refresh recovers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "round-csv-error-"));
    let fail = false;
    const log = new ScoreCsvLog(async () => { if (fail) throw new Error("database unavailable"); return [game()]; }, directory);
    try {
        await log.refresh();
        const original = await readFile(join(directory, "round-scores.csv"), "utf8");
        fail = true;
        await assert.rejects(log.refresh(), /database unavailable/);
        assert.equal(await readFile(join(directory, "round-scores.csv"), "utf8"), original);
        fail = false;
        await log.refresh();
        await log.flush();
        assert.equal(await readFile(join(directory, "round-scores.csv"), "utf8"), original);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
