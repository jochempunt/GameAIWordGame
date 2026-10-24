import { readFileSync } from "node:fs";
import type { AnswerOrigin } from "../types.js";
import type { Range } from "./botSettings.js";
import { randomInRange } from "./botSettings.js";

type Random = () => number;

function pickRandom<T>(items: T[], random: Random): T | undefined {
    return items.length === 0 ? undefined : items[Math.floor(random() * items.length)];
}

/** The candidates used least so far, so answers are spread evenly. */
function leastUsed<T>(items: T[], usage: (item: T) => number): T[] {
    const lowest = Math.min(...items.map(usage));
    return items.filter(item => usage(item) === lowest);
}


// ---- A. Random word combinations ----

export function randomAnswer(hand: string[], length: Range, random: Random = Math.random): string[] {
    const remaining = [...hand];
    const count = Math.min(remaining.length, Math.max(1, randomInRange(length, random)));
    const words: string[] = [];

    while (words.length < count) {
        const [word] = remaining.splice(Math.floor(random() * remaining.length), 1);
        words.push(word);
    }
    return words;
}


// ---- B. Pre-generated answers ----

type PresetAnswer = { key: string; words: string[]; uses: number };

export type PregeneratedFile = {
    anyPrompt: string[];
    prompts: Record<string, string[]>;
};

/** Splits preset answers into words, dropping (and reporting) any that the word pool cannot deal. */
export function parsePregeneratedAnswers(
    file: PregeneratedFile,
    wordSet: Set<string>,
    maxWords: number,
    knownPrompts: readonly string[],
): { byPrompt: Map<string, string[][]>; anyPrompt: string[][]; problems: string[] } {
    const problems: string[] = [];
    const parse = (context: string, answers: unknown): string[][] => {
        if (!Array.isArray(answers)) {
            problems.push(`${context}: expected a list of answers`);
            return [];
        }
        return answers.flatMap(answer => {
            const words = typeof answer === "string" ? answer.trim().split(/\s+/).filter(Boolean) : [];
            const unknown = words.filter(word => !wordSet.has(word));
            if (words.length === 0 || words.length > maxWords || unknown.length > 0) {
                problems.push(`${context}: "${String(answer)}" ${
                    unknown.length > 0 ? `uses words outside words.txt: ${unknown.join(", ")}` : "has an invalid length"
                }`);
                return [];
            }
            return [words];
        });
    };

    const byPrompt = new Map<string, string[][]>();
    for (const [prompt, answers] of Object.entries(file.prompts ?? {})) {
        if (!knownPrompts.includes(prompt)) problems.push(`Unknown prompt: "${prompt}"`);
        byPrompt.set(prompt, parse(prompt, answers));
    }

    return { byPrompt, anyPrompt: parse("anyPrompt", file.anyPrompt ?? []), problems };
}

export function loadPregeneratedFile(): PregeneratedFile {
    return JSON.parse(
        readFileSync(new URL("./pregeneratedAnswers.json", import.meta.url), "utf8"),
    ) as PregeneratedFile;
}

export function loadPregeneratedPool(
    wordSet: Set<string>,
    maxWords: number,
    knownPrompts: readonly string[],
): PregeneratedPool {
    const { byPrompt, anyPrompt, problems } = parsePregeneratedAnswers(
        loadPregeneratedFile(), wordSet, maxWords, knownPrompts,
    );
    for (const problem of problems) console.warn(`pregeneratedAnswers.json: ${problem}`);
    return new PregeneratedPool(byPrompt, anyPrompt);
}

export class PregeneratedPool {
    private readonly byPrompt = new Map<string, PresetAnswer[]>();
    private readonly anyPrompt: PresetAnswer[];

    constructor(byPrompt: Map<string, string[][]>, anyPrompt: string[][]) {
        for (const [prompt, answers] of byPrompt) {
            this.byPrompt.set(prompt, answers.map(words => ({ key: `${prompt}|${words.join(" ")}`, words, uses: 0 })));
        }
        this.anyPrompt = anyPrompt.map(words => ({ key: `*|${words.join(" ")}`, words, uses: 0 }));
    }

    /** Prompt-specific answers first; the generic ones only when those are used up this round. */
    select(prompt: string, excludedKeys: Set<string>, random: Random = Math.random): PresetAnswer | undefined {
        for (const answers of [this.byPrompt.get(prompt) ?? [], this.anyPrompt]) {
            const candidates = answers.filter(answer => !excludedKeys.has(answer.key));
            if (candidates.length === 0) continue;

            const chosen = pickRandom(leastUsed(candidates, answer => answer.uses), random)!;
            chosen.uses++;
            return chosen;
        }
        return undefined;
    }
}


// ---- C. Previously collected human answers ----

export type ReusableAnswer = {
    id: string;
    prompt: string;
    words: string[];
    authorId: string;
    sourceGameId: string;
    sourceRoundNumber: number;
    sourceRoundId: string;
    sourceAnswerId: string;
    collectedAt: Date;
    usageCount: number;
    lastUsedAt: Date | null;
};

export type ReusableAnswerStore = {
    insert(answers: ReusableAnswer[]): Promise<void>;
    recordUse(id: string, at: Date): Promise<void>;
};

export class ReusableAnswerPool {
    private readonly byPrompt = new Map<string, Map<string, ReusableAnswer>>();

    constructor(private readonly store?: ReusableAnswerStore) {}

    get size(): number {
        return [...this.byPrompt.values()].reduce((total, answers) => total + answers.size, 0);
    }

    /** Adds answers loaded from the database, without writing them back. */
    load(answers: Iterable<ReusableAnswer>): void {
        for (const answer of answers) this.insertInMemory(answer);
    }

    /** Adds newly collected answers; ones already in the pool are ignored. */
    add(answers: ReusableAnswer[]): ReusableAnswer[] {
        const added = answers.filter(answer => this.insertInMemory(answer));
        if (added.length > 0 && this.store) {
            this.store.insert(added).catch(error => {
                console.error("Could not save reusable answers:", error);
            });
        }
        return added;
    }

    select(
        prompt: string,
        options: { excludedAuthorIds: Set<string>; excludedIds: Set<string>; now: number; cooldownMs: number },
        random: Random = Math.random,
    ): ReusableAnswer | undefined {
        const candidates = [...(this.byPrompt.get(prompt)?.values() ?? [])].filter(answer =>
            !options.excludedAuthorIds.has(answer.authorId)
            && !options.excludedIds.has(answer.id)
            && (answer.lastUsedAt === null || options.now - answer.lastUsedAt.getTime() >= options.cooldownMs),
        );
        if (candidates.length === 0) return undefined;

        return pickRandom(leastUsed(candidates, answer => answer.usageCount), random);
    }

    markUsed(answer: ReusableAnswer, now: number): void {
        const at = new Date(now);
        answer.usageCount++;
        answer.lastUsedAt = at;
        this.store?.recordUse(answer.id, at).catch(error => {
            console.error(`Could not record use of reusable answer ${answer.id}:`, error);
        });
    }

    private insertInMemory(answer: ReusableAnswer): boolean {
        let answers = this.byPrompt.get(answer.prompt);
        if (!answers) {
            answers = new Map();
            this.byPrompt.set(answer.prompt, answers);
        }
        if (answers.has(answer.id)) return false;
        answers.set(answer.id, answer);
        return true;
    }
}


// ---- Choosing answers for the bots in one round ----

export type PlannedAnswer =
    | { origin: AnswerOrigin & { provenance: "bot_reused_human" }; words: string[] }
    | { origin: AnswerOrigin & { provenance: "bot_pregenerated" }; words: string[] }
    | { origin: AnswerOrigin & { provenance: "bot_random" }; words: null }; // picked from the dealt hand

export type PlanInput = {
    prompt: string;
    botIds: string[];
    excludedAuthorIds: Set<string>; // every human in the room: never show anyone their own answer
    allowReused: boolean;
    reusedAnswerChance: number;
    pregeneratedAnswerChance: number;
    reuseCooldownMs: number;
    now: number;
    pregenerated: PregeneratedPool;
    reusable: ReusableAnswerPool;
    random?: Random;
};

/**
 * Decides once per round whether bots reuse collected human answers, so a round either stays
 * research-eligible as a whole or falls back to synthetic answers for the bots without one.
 */
export function planBotAnswers(input: PlanInput): Map<string, PlannedAnswer> {
    const random = input.random ?? Math.random;
    const plans = new Map<string, PlannedAnswer>();
    const usedReusable = new Set<string>();
    const usedPresets = new Set<string>();
    const tryReused = input.allowReused && random() < input.reusedAnswerChance;

    for (const botId of input.botIds) {
        const reused = tryReused
            ? input.reusable.select(input.prompt, {
                excludedAuthorIds: input.excludedAuthorIds,
                excludedIds: usedReusable,
                now: input.now,
                cooldownMs: input.reuseCooldownMs,
            }, random)
            : undefined;

        if (reused) {
            usedReusable.add(reused.id);
            input.reusable.markUsed(reused, input.now);
            plans.set(botId, {
                words: [...reused.words],
                origin: {
                    provenance: "bot_reused_human",
                    reusedFrom: {
                        reusableAnswerId: reused.id,
                        originalAuthorId: reused.authorId,
                        originalRoundId: reused.sourceRoundId,
                    },
                },
            });
            continue;
        }

        const preset = random() < input.pregeneratedAnswerChance
            ? input.pregenerated.select(input.prompt, usedPresets, random)
            : undefined;
        if (preset) {
            usedPresets.add(preset.key);
            plans.set(botId, { words: [...preset.words], origin: { provenance: "bot_pregenerated" } });
            continue;
        }

        plans.set(botId, { words: null, origin: { provenance: "bot_random" } });
    }

    return plans;
}
