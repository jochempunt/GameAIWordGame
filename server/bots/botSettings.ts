import { readFileSync } from "node:fs";

export type Range = { min: number; max: number };

export type BotSettings = {
    enabled: boolean;
    backgroundRooms: Range; // rooms kept populated by bots while no humans are around
    backgroundBotsPerRoom: Range;
    backgroundRoundIntervalMs: Range; // pause between autonomous bot-only rounds
    backgroundRetargetIntervalMs: Range; // how often a background room re-rolls its bot count
    maxBotOnlyRoundsPerSession: number; // bot-only sessions restart after this many rounds
    assistTargetPlayers: Range; // total participants bots fill a room up to while humans are short
    assistDelayMs: Range; // how long humans wait before the first bot joins
    joinGapMs: Range;
    leaveGapMs: Range;
    answerDelayMs: Range;
    rankingDelayMs: Range;
    readyDelayMs: Range;
    catchUpDelayMs: Range; // used instead once every human in the round has acted
    deadlineSafetyMs: number; // bots act at least this long before a phase timer ends
    randomAnswerWords: Range;
    reusedAnswerChance: number; // chance a round uses collected human answers when available
    pregeneratedAnswerChance: number; // otherwise, chance of a preset answer over random words
    reuseCooldownMs: number; // a collected answer is not reused again within this time
    minReusableAnswerWords: number;
    emoteChance: number;
    greetingReplyChance: number; // chance a bot greets back when a human greets for the first time
    greetingReplyDecay: number; // multiplies that chance for each further greeting by the same human
    waitingEmoteChance: number; // after answering, chance of a "hurry up" or "ready" emote
    emoteReplyDelayMs: Range;
    waitingEmoteDelayMs: Range;
};

const RANGE_KEYS = [
    "backgroundRooms", "backgroundBotsPerRoom", "backgroundRoundIntervalMs",
    "backgroundRetargetIntervalMs", "assistTargetPlayers", "assistDelayMs", "joinGapMs",
    "leaveGapMs", "answerDelayMs", "rankingDelayMs", "readyDelayMs", "catchUpDelayMs", "randomAnswerWords",
    "emoteReplyDelayMs", "waitingEmoteDelayMs",
] as const;
const COUNT_KEYS = [
    "maxBotOnlyRoundsPerSession", "deadlineSafetyMs", "reuseCooldownMs", "minReusableAnswerWords",
] as const;
const CHANCE_KEYS = [
    "reusedAnswerChance", "pregeneratedAnswerChance", "emoteChance",
    "greetingReplyChance", "greetingReplyDecay", "waitingEmoteChance",
] as const;
const KEYS: (keyof BotSettings)[] = ["enabled", ...RANGE_KEYS, ...COUNT_KEYS, ...CHANCE_KEYS];

const MAX_TIMER_DELAY = 2_147_483_647;

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseBotSettings(value: unknown): Readonly<BotSettings> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("bot_settings.json must contain an object");
    }

    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) {
        if (!KEYS.includes(key as keyof BotSettings)) {
            throw new Error(`Unknown bot setting: ${key}`);
        }
    }
    for (const key of KEYS) {
        if (!(key in input)) throw new Error(`bot_settings.json: ${key} is missing`);
    }

    if (typeof input.enabled !== "boolean") {
        throw new Error("bot_settings.json: enabled must be true or false");
    }
    for (const key of RANGE_KEYS) {
        const range = input[key] as Partial<Range> | null;
        if (
            !range || typeof range !== "object"
            || !isNonNegativeInteger(range.min) || !isNonNegativeInteger(range.max)
            || range.min > range.max || range.max > MAX_TIMER_DELAY
        ) {
            throw new Error(`bot_settings.json: ${key} must be { "min": n, "max": m } with 0 <= n <= m`);
        }
    }
    for (const key of COUNT_KEYS) {
        if (!isNonNegativeInteger(input[key]) || (input[key] as number) > MAX_TIMER_DELAY) {
            throw new Error(`bot_settings.json: ${key} must be a non-negative integer`);
        }
    }
    for (const key of CHANCE_KEYS) {
        const chance = input[key];
        if (typeof chance !== "number" || !(chance >= 0 && chance <= 1)) {
            throw new Error(`bot_settings.json: ${key} must be between 0 and 1`);
        }
    }

    const settings = input as BotSettings;
    if (settings.randomAnswerWords.min < 1) {
        throw new Error("bot_settings.json: randomAnswerWords.min must be at least 1");
    }

    return Object.freeze({ ...settings });
}

export const botSettings = parseBotSettings(
    JSON.parse(readFileSync(new URL("../../bot_settings.json", import.meta.url), "utf8")),
);

export function randomInRange(range: Range, random: () => number = Math.random): number {
    return range.min + Math.floor(random() * (range.max - range.min + 1));
}
