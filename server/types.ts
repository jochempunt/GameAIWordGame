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

type Phase = "lobby" | "answering" | "ranking" ;
export type GameState = {
    phase: Phase;
    round: number;
    rounds: Map<number, RoundState>;
    totals: Map<string, number>;          
};


export type PlayerView = {name:string} & (
    | {phase:"lobby"}
    | {phase:"answering"; round:number; prompt:string; words:string[], submitted:string[] | null}
    | {phase:"ranking"; round:number; prompt:string; answers:Answer[]}
);


export type HostView = {
    phase: Phase; 
    round: number; 
    prompt: string | null; 
    players: { 
        playerInfo: Player;
        answered: boolean; 
        ranked: boolean; 
        score: number 
    }[];
    answers: { id: string; words: string[] }[];      
};