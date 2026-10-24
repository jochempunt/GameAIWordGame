import { test } from "node:test";
import assert from "node:assert/strict";
import {
    loadPregeneratedFile,
    parsePregeneratedAnswers,
    planBotAnswers,
    PregeneratedPool,
    randomAnswer,
    ReusableAnswerPool,
} from "./answerSources.js";
import type { ReusableAnswer } from "./answerSources.js";
import { PROMPTS } from "../prompts.js";
import { WORD_SET } from "../words.js";
import { settings } from "../settings_validation.js";

const PROMPT = PROMPTS[0];

function reusable(id: string, authorId: string, extra: Partial<ReusableAnswer> = {}): ReusableAnswer {
    return {
        id,
        prompt: PROMPT,
        words: ["the", "cat", id],
        authorId,
        sourceGameId: "game",
        sourceRoundNumber: 1,
        sourceRoundId: "game:1",
        sourceAnswerId: `answer-${id}`,
        collectedAt: new Date(0),
        usageCount: 0,
        lastUsedAt: null,
        ...extra,
    };
}

function plan(pool: ReusableAnswerPool, options: Partial<Parameters<typeof planBotAnswers>[0]> = {}) {
    return planBotAnswers({
        prompt: PROMPT,
        botIds: ["bot-1", "bot-2"],
        excludedAuthorIds: new Set(),
        allowReused: true,
        reusedAnswerChance: 1,
        pregeneratedAnswerChance: 1,
        reuseCooldownMs: 0,
        now: 1_000_000,
        pregenerated: new PregeneratedPool(new Map([[PROMPT, [["oops"], ["no"]]]]), []),
        reusable: pool,
        ...options,
    });
}

test("every pre-generated answer can be dealt from words.txt and belongs to a known prompt", () => {
    const { byPrompt, anyPrompt, problems } = parsePregeneratedAnswers(
        loadPregeneratedFile(), WORD_SET, settings.wordsPerPlayer, PROMPTS,
    );
    assert.deepEqual(problems, []);
    assert.ok(anyPrompt.length > 0);
    for (const prompt of PROMPTS) {
        assert.ok((byPrompt.get(prompt)?.length ?? 0) >= 3, `few preset answers for "${prompt}"`);
    }
});

test("invalid preset answers are reported and dropped", () => {
    const { byPrompt, problems } = parsePregeneratedAnswers(
        { anyPrompt: [], prompts: { [PROMPT]: ["the cat", "the xylophone"] } },
        WORD_SET, settings.wordsPerPlayer, PROMPTS,
    );
    assert.deepEqual(byPrompt.get(PROMPT), [["the", "cat"]]);
    assert.equal(problems.length, 1);
});

test("random answers only use words from the hand, each dealt word at most once", () => {
    const hand = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < 50; i++) {
        const words = randomAnswer(hand, { min: 2, max: 4 });
        assert.ok(words.length >= 2 && words.length <= 4);
        assert.equal(new Set(words).size, words.length);
        assert.ok(words.every(word => hand.includes(word)));
    }
});

test("pre-generated answers are spread evenly and not repeated within a round", () => {
    const pool = new PregeneratedPool(new Map([[PROMPT, [["a"], ["b"], ["c"]]]]), [["generic"]]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
        const answer = pool.select(PROMPT, new Set())!;
        counts.set(answer.words[0], (counts.get(answer.words[0]) ?? 0) + 1);
    }
    assert.deepEqual([...counts.values()], [10, 10, 10]);

    const used = new Set<string>();
    const round = [1, 2, 3, 4].map(() => {
        const answer = pool.select(PROMPT, used)!;
        used.add(answer.key);
        return answer.words[0];
    });
    // the generic answers only fill in once the prompt's own are used up
    assert.deepEqual(round.slice(0, 3).sort(), ["a", "b", "c"]);
    assert.equal(round[3], "generic");
});

test("a reused answer is never chosen while its author is in the room", () => {
    const pool = new ReusableAnswerPool();
    pool.load([reusable("mine", "human-1"), reusable("theirs", "human-2")]);

    for (let i = 0; i < 20; i++) {
        const plans = plan(pool, { botIds: ["bot-1"], excludedAuthorIds: new Set(["human-1"]) });
        const chosen = plans.get("bot-1")!;
        assert.equal(chosen.origin.provenance, "bot_reused_human");
        assert.equal(chosen.origin.reusedFrom?.originalAuthorId, "human-2");
    }

    const onlyMine = new ReusableAnswerPool();
    onlyMine.load([reusable("mine", "human-1")]);
    const fallback = plan(onlyMine, { botIds: ["bot-1"], excludedAuthorIds: new Set(["human-1"]) });
    assert.equal(fallback.get("bot-1")!.origin.provenance, "bot_pregenerated");
});

test("bots in one round never present the same reused answer", () => {
    const pool = new ReusableAnswerPool();
    pool.load([reusable("x", "human-1"), reusable("y", "human-2")]);

    const plans = plan(pool, { botIds: ["bot-1", "bot-2", "bot-3"] });
    const reusedIds = [...plans.values()]
        .flatMap(p => p.origin.reusedFrom ? [p.origin.reusedFrom.reusableAnswerId] : []);
    assert.deepEqual(reusedIds.sort(), ["x", "y"]);
    // the third bot falls back to a synthetic answer
    assert.equal([...plans.values()].filter(p => p.origin.provenance !== "bot_reused_human").length, 1);
});

test("reused answers prefer the least used and respect the cooldown", () => {
    const pool = new ReusableAnswerPool();
    pool.load([
        reusable("used", "human-1", { usageCount: 5 }),
        reusable("fresh", "human-2"),
        reusable("recent", "human-3", { lastUsedAt: new Date(999_000) }),
    ]);

    const first = plan(pool, { botIds: ["bot-1"], reuseCooldownMs: 60_000 }).get("bot-1")!;
    assert.equal(first.origin.reusedFrom?.reusableAnswerId, "fresh");

    // "fresh" is now on cooldown and "recent" still is, so "used" is the only one left
    const second = plan(pool, { botIds: ["bot-1"], reuseCooldownMs: 60_000 }).get("bot-1")!;
    assert.equal(second.origin.reusedFrom?.reusableAnswerId, "used");
});

test("collected answers are not spent on rounds without humans", () => {
    const pool = new ReusableAnswerPool();
    pool.load([reusable("x", "human-1")]);
    const plans = plan(pool, { botIds: ["bot-1"], allowReused: false });
    assert.notEqual(plans.get("bot-1")!.origin.provenance, "bot_reused_human");
});

test("duplicate collected answers are stored once", async () => {
    const inserted: string[] = [];
    const pool = new ReusableAnswerPool({
        insert: async answers => { inserted.push(...answers.map(answer => answer.id)); },
        recordUse: async () => undefined,
    });
    pool.add([reusable("x", "human-1")]);
    pool.add([reusable("x", "human-1"), reusable("y", "human-1")]);
    assert.deepEqual(inserted, ["x", "y"]);
    assert.equal(pool.size, 2);
});
