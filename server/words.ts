import { readFileSync } from "node:fs";
import { settings } from "./settings_validation.js";

export const WORDS = readFileSync(new URL("./words.txt", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map(word => word.trim())
    .filter(Boolean);

if (settings.wordsPerPlayer > WORDS.length) {
    throw new Error("wordsPerPlayer must not exceed the number of entries in server/words.txt");
}

export function dealWords(): string[] {
    const words = [...WORDS];

   // shuffle words
    for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [words[i], words[j]] = [words[j], words[i]];
    }

    return words.slice(0, settings.wordsPerPlayer);
}
