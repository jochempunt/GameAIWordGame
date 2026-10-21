import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackgroundModelTrainer, retrainHumorModel, runTrainingProcess } from "./backgroundTraining.js";
import { readHumorPredictor } from "./predictions.js";
import type { HumorPredictor } from "./predictions.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function model(score: number): HumorPredictor {
    return { predictTask: task => task.inputs.candidates.map(candidate => ({ answer_id: candidate.answer_id, score })) };
}

test("slow training keeps the previous scorer available and coalesces completed rounds", async () => {
    const old = model(0), first = model(1), second = model(2);
    const gates = [deferred<HumorPredictor>(), deferred<HumorPredictor>()];
    let calls = 0;
    const trainer = new BackgroundModelTrainer(old, () => gates[calls++].promise, () => {});
    trainer.request();
    trainer.request();
    trainer.request();
    assert.equal(calls, 1);
    assert.equal(trainer.model, old);
    gates[0].resolve(first);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(trainer.model, first);
    gates[1].resolve(second);
    await trainer.idle();
    assert.equal(calls, 2);
    assert.equal(trainer.model, second);
    await trainer.stop();
});

test("failed training leaves the previous model intact and later rounds can retry", async () => {
    const old = model(0), next = model(1);
    let calls = 0;
    const trainer = new BackgroundModelTrainer(old, async () => {
        if (++calls === 1) throw new Error("failed worker");
        return next;
    }, () => {});
    trainer.request();
    await trainer.idle();
    assert.equal(trainer.model, old);
    trainer.request();
    await trainer.idle();
    assert.equal(trainer.model, next);
    await trainer.stop();
});

test("shutdown cancels training and discards queued updates", async () => {
    const old = model(0);
    let calls = 0;
    const trainer = new BackgroundModelTrainer(old, signal => {
        calls++;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))));
    }, () => {});
    trainer.request();
    trainer.request();
    await trainer.stop();
    trainer.request();
    assert.equal(calls, 1);
    assert.equal(trainer.model, old);
});

test("a worker exceeding its deadline is killed", async () => {
    await assert.rejects(runTrainingProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"],
        new AbortController().signal, 30), /training exceeded/);
});

test("loading a replaced scorer as data keeps old model references valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "humor-cache-"));
    const path = join(dir, "model.cjs");
    try {
        await writeFile(path, "module.exports={predictTask:()=>[{answer_id:'a',score:1}]};");
        const old = readHumorPredictor(path);
        await writeFile(path, "module.exports={predictTask:()=>[{answer_id:'a',score:2}]};");
        const next = readHumorPredictor(path);
        const task = { inputs: { prompt: "", candidates: [] } };
        assert.equal(old.predictTask(task)[0].score, 1);
        assert.equal(next.predictTask(task)[0].score, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real Python worker trains and atomically replaces a scorer without touching live game state", {
    skip: !existsSync(new URL("../.venv/bin/python", import.meta.url)) && !process.env.HUMOR_PYTHON,
}, async () => {
    const dir = await mkdtemp(join(tmpdir(), "humor-background-"));
    const path = join(dir, "model.cjs");
    const old = "module.exports={predictTask:()=>[]};";
    const snapshot = deferred<unknown[]>();
    try {
        await writeFile(path, old);
        const pending = retrainHumorModel(() => snapshot.promise, new AbortController().signal, path);
        assert.equal(await readFile(path, "utf8"), old);
        const players = ["one", "two", "three"];
        const words = ["cat", "sleepy", "funny"];
        // Explicitly synthetic fixtures: these check execution, not humor accuracy.
        const rounds = Array.from({ length: 6 }, (_, round) => ({
            roundNumber: round + 1, status: "completed", prompt: "A funny cat",
            playerIds: players,
            wordsAvailable: players.map(playerId => ({ playerId, words })),
            answers: players.map((playerId, i) => ({ playerId, answerId: `${round}-${i}`, words: [words[i]] })),
            scores: players.map((_, i) => ({ answerId: `${round}-${i}`, score: 4 - i })),
        }));
        snapshot.resolve([{ _id: "synthetic-background-test", state: { rounds } }]);
        const candidate = await pending;
        assert.notEqual(await readFile(path, "utf8"), old);
        const result = candidate.predictTask({ inputs: { prompt: "A funny cat", candidates: players.map((player_id, i) => ({
            player_id, answer_id: `new-${i}`, available_words: words, answer_tokens: [words[i]],
        })) } });
        assert.equal(result.length, 3);
        assert.ok(result.every(row => Number.isFinite(row.score)));
        const report = JSON.parse(await readFile(join(dir, "background_training.json"), "utf8"));
        assert.equal(report.rounds, 6);
        assert.equal(report.javascript_parity.status, "passed");
    } finally { await rm(dir, { recursive: true, force: true }); }
});
