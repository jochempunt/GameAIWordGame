import type { Player } from "../types.js";

export type PopulationInput = {
    humansInRoom: number; // every human record, including disconnected ones not yet removed
    humansPresent: number; // connected or within reconnect grace
    bots: number;
    background: boolean;
    backgroundTarget: number;
    assistTarget: number; // total participants to fill up to while humans are short
    minPlayersToStart: number;
    capacity: number;
};

/** How many bots a room should eventually have. Changes are applied gradually by the bot manager. */
export function desiredBotCount(input: PopulationInput): number {
    const { humansInRoom, humansPresent, bots, minPlayersToStart } = input;

    if (humansInRoom === 0) {
        return input.background ? Math.min(input.backgroundTarget, input.capacity) : 0;
    }
    // Everyone human is away for now (e.g. locked phone screens): keep the room as it is.
    if (humansPresent === 0) return bots;
    if (humansPresent >= minPlayersToStart) return 0;

    const wanted = Math.max(
        minPlayersToStart - humansPresent,
        input.assistTarget - humansPresent,
    );
    return Math.max(0, Math.min(wanted, input.capacity - humansInRoom));
}

/** The player who should host: a connected human if any, otherwise a bot. */
export function preferredHost(players: Iterable<Player>): Player | undefined {
    let botCandidate: Player | undefined;
    for (const player of players) {
        if (!player.connected) continue;
        if (!player.isBot) return player;
        botCandidate ??= player;
    }
    return botCandidate;
}

/** A bot host must hand over as soon as a connected human is in the room. */
export function shouldHandHostToHuman(
    hostPlayerId: string | null,
    players: Map<string, Player>,
): Player | undefined {
    const host = hostPlayerId ? players.get(hostPlayerId) : undefined;
    if (host && !host.isBot && host.connected) return undefined;

    const candidate = preferredHost(players.values());
    if (!candidate || candidate.isBot) return undefined;
    // keep a disconnected human host during its grace; only replace bots or an empty seat
    if (host && !host.isBot) return undefined;
    return candidate;
}
