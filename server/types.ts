type PlayerId = string;
type AnswerId = string;

import type { Game } from "./game.js"

export type Player = {
    id: string;
    socketId: string;
    name: string;
    connected: boolean;
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
    answers: Answer[];
    rankings: Map<string, Ranking>;
    scores?: Map<string, number>;
};

type Phase = "lobby" | "answering" | "ranking" | "results";
export type GameState = {
    phase: Phase;
    round: number;
    rounds: Map<number, RoundState>;
    totals: Map<string, number>;
};

export type PlayerSummary = {
    name: string;
    connected: boolean;
    isHost: boolean;
    isActive: boolean;
    answered: boolean;
    ranked: boolean;
    score: number;
};

export type PlayerView = {
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
            playerName: string;
            words: string[];
            score: number;
        }[];
        leaderboard: {
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
        answers: Answer[];
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
