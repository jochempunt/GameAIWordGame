type PlayerId = string;
type AnswerId = string;


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

export type Vote = {
    playerId: PlayerId;
    answerId: AnswerId;
};

export type RoundState = {
    prompt: string;
    words: string[];

    answers: Answer[];
    votes: Vote[];

    winnerId?: AnswerId;
};

export type GameState = {
    phase: "LOBBY" | "PLAYING" | "VOTING" | "RESULTS";
    round: number;

    rounds: Map<number, RoundState>;
};