import { createHash } from "node:crypto";
import type { AnswerProvenance, Phase, Room } from "./types.js";

// Admins are configured only on the server (ADMIN_IDS in .env). Clients learn about admin
// mode only when the server recognises their session, and every admin action is checked again.

const SESSION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAYER_ID = /^[0-9a-f]{64}$/;

export function playerIdForToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/**
 * Accepts session token UUIDs or participant IDs (the token's SHA-256), separated by commas or
 * whitespace. Participant IDs are safer to keep in config: they cannot be used to log in.
 */
export function parseAdminIds(value: string | undefined): { ids: Set<string>; invalid: string[] } {
    const ids = new Set<string>();
    const invalid: string[] = [];

    for (const entry of (value ?? "").split(/[\s,]+/).map(item => item.trim().toLowerCase()).filter(Boolean)) {
        if (SESSION_TOKEN.test(entry)) ids.add(playerIdForToken(entry));
        else if (PLAYER_ID.test(entry)) ids.add(entry);
        else invalid.push(entry);
    }

    return { ids, invalid };
}

export type AdminPlayer = {
    id: string;
    name: string;
    isBot: boolean;
    connected: boolean;
    reconnecting: boolean;
    isHost: boolean;
    isActive: boolean;
    answered: boolean;
    ranked: boolean;
    ready: boolean;
    score: number;
};

export type AdminAnswer = {
    playerId: string;
    playerName: string;
    words: string[];
    provenance: AnswerProvenance;
};

export type AdminRoom = {
    id: string;
    phase: Phase;
    round: number;
    prompt: string | null;
    locked: boolean;
    stageEndsAt: number | null;
    background: boolean; // kept populated by bots while no humans are around
    botsPaused: boolean; // by an admin
    botsDisabledByHost: boolean;
    spectators: number; // admins watching invisibly
    players: AdminPlayer[];
    answers: AdminAnswer[]; // current round, live
};

export type AdminTotals = {
    visitors: number; // every open connection, including the consent screen
    online: number; // distinct consented participants connected
    inRooms: number; // of those, connected as a player in a room
    browsing: number; // connected but not in any room
    bots: number;
    admins: number;
};

export type AdminState = {
    serverNow: number;
    hidden: boolean;
    botsPaused: boolean;
    spectating: string | null;
    totals: AdminTotals;
    rooms: AdminRoom[];
};

export function summarizeRoomForAdmin(
    room: Room,
    extras: { background: boolean; botsPaused: boolean; botsDisabledByHost: boolean; spectators: number },
): AdminRoom {
    const game = room.game;
    const round = game.currentRound();
    const isLobby = game.state.phase === "lobby";
    const players = [...room.players.values()];

    return {
        id: room.id,
        phase: game.state.phase,
        round: game.state.round,
        prompt: isLobby ? null : round?.prompt ?? null,
        locked: room.locked,
        stageEndsAt: room.stageEndsAt,
        ...extras,
        players: players.map(player => ({
            id: player.id,
            name: player.name,
            isBot: player.isBot === true,
            connected: player.connected,
            reconnecting: player.reconnecting === true,
            isHost: player.id === room.hostPlayerId,
            isActive: isLobby || room.activePlayerIds.has(player.id),
            answered: !isLobby && (round?.answers.some(answer => answer.playerId === player.id) ?? false),
            ranked: !isLobby && (round?.rankings.has(player.id) ?? false),
            ready: room.readyPlayers.has(player.id),
            score: game.state.totals.get(player.id) ?? 0,
        })),
        answers: isLobby || !round ? [] : round.answers.map(answer => ({
            playerId: answer.playerId,
            playerName: room.players.get(answer.playerId)?.name
                ?? game.state.players.get(answer.playerId)?.name
                ?? "Unknown player",
            words: answer.words,
            provenance: answer.provenance ?? "human_original",
        })),
    };
}

export function countVisitors(
    connections: Iterable<{ consentedPlayerId?: string }>,
    rooms: Iterable<Room>,
    adminIds: Set<string>,
): AdminTotals {
    let visitors = 0;
    const online = new Set<string>();
    for (const connection of connections) {
        visitors++;
        if (connection.consentedPlayerId) online.add(connection.consentedPlayerId);
    }

    const inRooms = new Set<string>();
    let bots = 0;
    for (const room of rooms) {
        for (const player of room.players.values()) {
            if (player.isBot) bots++;
            else if (player.connected) inRooms.add(player.id);
        }
    }

    return {
        visitors,
        online: online.size,
        inRooms: inRooms.size,
        browsing: [...online].filter(id => !inRooms.has(id)).length,
        bots,
        admins: [...online].filter(id => adminIds.has(id)).length,
    };
}
