import { readFileSync } from "node:fs";
import { settings } from "./settings_validation.js";

export const WORDS = readFileSync(new URL("./words.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map(word => word.trim())
    .filter(Boolean);

if (settings.wordsPerPlayer > WORDS.length) {
    throw new Error("wordsPerPlayer must not exceed the number of entries in server/words.txt");
}

export const WORD_SET = new Set(WORDS);

function shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

// Bots pass the words of their planned answer so it passes the normal hand validation.
export function dealWords(requiredWords: string[] = []): string[] {
    const fill = shuffle([...WORDS])
        .slice(0, Math.max(0, settings.wordsPerPlayer - requiredWords.length));

    return requiredWords.length === 0 ? fill : shuffle([...requiredWords, ...fill]);
}
