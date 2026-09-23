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


type Ranking = string[];   

export type RoundState = {
    prompt: string;
    words: string[];
    answers: Answer[];                      
    rankings: Map<string, Ranking>;           
    scores?: Map<string, number>;             
};

type Phase = "lobby" | "answering" | "ranking" | "results" | "ended";
export type GameState = {
    phase: Phase;
    round: number;
    rounds: Map<number, RoundState>;
    totals: Map<string, number>;          
};


