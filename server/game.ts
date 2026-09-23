import { WORDS } from "./words.js";
import { PROMPTS } from "./prompts.js";

import type {
    Answer,
    GameState,
    RoundState,
} from "./types.js";

export class Game {
    state: GameState = {
        phase: "lobby",
        round: 0,
        rounds: new Map<number, RoundState>(),
        totals: new Map<string, number>()
    };
    
    
    currentRound(): RoundState | undefined {
        return this.state.rounds.get(this.state.round);
    }
    
    startRound(): boolean {
        if (this.state.phase !== "lobby") {
            return false;
        }
        
        this.state.round++;
        
        const round: RoundState = {
            prompt: this.randomPrompt(),
            words: this.randomWords(20),
            answers: [],
            rankings: new Map<string, string[]>(),
        };
        
        this.state.rounds.set(this.state.round, round);
        this.state.phase = "answering";
        
        return true;
    }
    
    
    submitAnswer(
        playerId: string,
        words: string[],
    ): Answer | undefined {
        if (this.state.phase !== "answering") {
            return undefined;
        }
        
        const round = this.state.rounds.get(this.state.round);
        
        if (!round) {
            return undefined;
        }
        
        // Don't allow the same player to answer twice.
        const existingAnswer = round.answers.find(
            answer => answer.playerId === playerId,
        );
        
        if (existingAnswer) {
            return undefined;
        }
        
        // Make sure the submitted words belong to this round.
        if (!this.validateWords(words, round.words)) {
            return undefined;
        }
        
        const answer: Answer = {
            id: crypto.randomUUID(),
            playerId,
            words,
        };
        
        round.answers.push(answer);
        
        return answer;
    }
    
    // Get a player's answer from a specific round.
    getSpecificAnswer(
        roundNumber: number,
        playerId: string,
    ): Answer | undefined {
        return this.state.rounds
        .get(roundNumber)
        ?.answers
        .find(answer => answer.playerId === playerId);
    }
    
    
    getAnswers(roundNumber: number): Answer[] {
        return this.state.rounds.get(roundNumber)?.answers ?? [];
    }
    
    
    private validateWords(
        submittedWords: string[],
        availableWords: string[],
    ): boolean {
        if (submittedWords.length === 0) {
            return false;
        }
        
        const remainingWords = [...availableWords];
        
        for (const word of submittedWords) {
            const index = remainingWords.indexOf(word);
            
            if (index === -1) {
                return false;
            }
            
            remainingWords.splice(index, 1);
        }
        
        return true;
    }
    
    private randomPrompt(): string {
        const index = Math.floor(
            Math.random() * PROMPTS.length,
        );
        
        return PROMPTS[index];
    }
    
    private randomWords(count: number): string[] {
        return [...WORDS]
        .sort(() => Math.random() - 0.5)
        .slice(0, count);
    }
    
    
    
    
    
}