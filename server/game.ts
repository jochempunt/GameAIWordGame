import { WORDS } from "./words.js";
import { PROMPTS } from "./prompts.js";

import type {
    Answer,
    GameState,
    RoundState,
} from "./types.js";

const WORD_COUNT = 30;
export const MIN_PLAYERS_TO_START = 3;


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
        words: this.randomWords(WORD_COUNT),
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
        
        const existingAnswer = round.answers.find(
            answer => answer.playerId === playerId,
        );
        
        if (existingAnswer) {
            return undefined;
        }
        
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

    calculateScores(): void {
    const round = this.currentRound();

    if (!round) {
        return;
    }

    const scores = new Map<string, number>();

    for (const answer of round.answers) {
        scores.set(answer.id, 0);
    }

    for (const ranking of round.rankings.values()) {
        const totalAnswers = ranking.length;

        ranking.forEach((answerId, index) => {
            const points = totalAnswers - index;

            const currentScore = scores.get(answerId) ?? 0;

            scores.set(
                answerId,
                currentScore + points,
            );
        });
    }

    // An answer only scores if its author also ranked the others. Otherwise skipping the
    // ranking would withhold points from everyone else at no cost.
    for (const answer of round.answers) {
        const hadAnswersToRank = round.answers.some(
            other => other.playerId !== answer.playerId,
        );

        if (hadAnswersToRank && !round.rankings.has(answer.playerId)) {
            scores.set(answer.id, 0);
        }
    }

    round.scores = scores;
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
        const words = [...WORDS];

        // Fisher-Yates shuffle, so every word is equally likely to be picked
        for (let i = words.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));

            [words[i], words[j]] = [words[j], words[i]];
        }

        return words.slice(0, count);
    }
}
