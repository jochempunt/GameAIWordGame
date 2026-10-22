import { readFileSync } from "node:fs";

export type Settings = {
    wordsPerPlayer: number;
    minPlayersToStart: number;
    maxPlayersPerRoom: number;
    roomCount: number;
    visibleEmptyRoomCount: number;
    disconnectGraceMs: number;
    disconnectPurgeMs: number;
};

export type PublicSettings = Pick<Settings, "minPlayersToStart" | "visibleEmptyRoomCount">;

export function parseSettings(value: unknown): Readonly<Settings> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("settings.json must contain an object");
    }

    const input = value as Record<string, unknown>;
    const keys: (keyof Settings)[] = [
        "wordsPerPlayer", "minPlayersToStart", "maxPlayersPerRoom", "roomCount",
        "visibleEmptyRoomCount", "disconnectGraceMs", "disconnectPurgeMs",
    ];
    for (const key of Object.keys(input)) {
        if (!keys.includes(key as keyof Settings)) {
            throw new Error(`Unknown setting: ${key}`);
        }
    }
    for (const key of keys) {
        const number = input[key];
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
            throw new Error(`settings.json: ${key} must be a positive integer`);
        }
    }

    const settings = input as Settings;
    if (settings.minPlayersToStart > settings.maxPlayersPerRoom) {
        throw new Error("minPlayersToStart must not exceed maxPlayersPerRoom");
    }
    // Room codes currently use one letter A–Z repeated four times.
    if (settings.roomCount > 26) {
        throw new Error("roomCount must not exceed 26");
    }
    if (settings.visibleEmptyRoomCount > settings.roomCount) {
        throw new Error("visibleEmptyRoomCount must not exceed roomCount");
    }
    if (settings.disconnectPurgeMs < settings.disconnectGraceMs) {
        throw new Error("disconnectPurgeMs must be at least disconnectGraceMs");
    }
    for (const key of ["disconnectGraceMs", "disconnectPurgeMs"] as const) {
        if (settings[key] > 2_147_483_647) {
            throw new Error(`${key} exceeds the maximum supported timer delay`);
        }
    }

    return Object.freeze({ ...settings });
}

export const settings = parseSettings(
    JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8")),
);
