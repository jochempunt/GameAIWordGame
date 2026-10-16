type PlayerId = string;
type AnswerId = string;

import type { Game } from "./game.js"

export type Player = {
    id: string; // public, shown to the whole room
    token: string; // secret, only ever sent to the player it belongs to
    socketId: string;
    name: string;
    connected: boolean;
};

export type GamePlayer = {
    id: string;
    name: string;
    joinedAt: Date;
};

export type Answer = {
    id: AnswerId;
    playerId: PlayerId;
    words: string[];
};


type Ranking = string[];

export type RoundState = {
    prompt: string;
    words: string[];
    playerIds: string[];
    answers: Answer[];
    rankings: Map<string, Ranking>;
    scores?: Map<string, number>;
};

type Phase = "lobby" | "answering" | "ranking" | "results";
export type RoomSummary = {
    id: string;
    playerCount: number;
    capacity: number;
    phase: Phase;
};

export type GameState = {
    phase: Phase;
    round: number;
    players: Map<string, GamePlayer>;
    rounds: Map<number, RoundState>;
    totals: Map<string, number>;
};

export type PlayerSummary = {
    id: string;
    name: string;
    connected: boolean;
    isHost: boolean;
    isActive: boolean;
    answered: boolean;
    ranked: boolean;
    score: number;
};

export type PlayerView = {
    playerId: string;
    name: string;
    isHost: boolean;
    isActive: boolean;
    isSpectator: boolean;
    players: PlayerSummary[];
} & (
    | {
        phase: "lobby";
        isHost: boolean;
        canStartRound: boolean;
        lobbyCount: number;
        playerCount: number;
    }
    | {
        phase: "results";
        round: number;
        prompt: string;
        roundResults: {
            playerId: string;
            playerName: string;
            words: string[];
            score: number;
        }[];
        leaderboard: {
            playerId: string;
            playerName: string;
            rank: number;
        }[];
        readyCount: number;
        playerCount: number;
        isReady: boolean;
        canReady: boolean;
    }
    | {
        phase: "answering";
        round: number;
        prompt: string;
        words: string[];
        submitted: string[] | null;
        answeredCount: number;
        playerCount: number;
        canSubmit: boolean;
    }
    | {
        phase: "ranking";
        round: number;
        prompt: string;
        answers: { id: AnswerId; words: string[] }[];
        hasRanked: boolean;
        rankedCount: number;
        playerCount: number;
        canRank: boolean;
    }
);


export type HostView = {
    phase: Phase;
    round: number;
    prompt: string | null;
    players: {
        playerInfo: Player;
        isActive: boolean;
        answered: boolean;
        ranked: boolean;
        score: number
    }[];
    answers: { id: string; words: string[] }[];
};

export type Room = {
    id: string;
    game: Game;
    players: Map<string, Player>;
    readyPlayers: Set<string>;
    activePlayerIds: Set<string>;
    hostPlayerId: string | null;
}
