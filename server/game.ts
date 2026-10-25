import { settings } from "./settings_validation.js";
import { dealWords } from "./words.js";
import { PROMPTS } from "./prompts.js";

import type {
    Answer,
    AnswerOrigin,
    GameState,
    Ranking,
    RoundState,
} from "./types.js";

export const MIN_PLAYERS_TO_START = settings.minPlayersToStart;


export class Game {
    constructor(public readonly id: string = crypto.randomUUID()) {}

    state: GameState = {
        phase: "lobby",
        round: 0,
        players: new Map(),
        rounds: new Map<number, RoundState>(),
        totals: new Map<string, number>()
    };
    
    recordPlayer(playerId: string, name: string, isBot = false): void {
        if (this.state.players.has(playerId)) {
            return;
        }

        this.state.players.set(playerId, {
            id: playerId,
            name,
            joinedAt: new Date(),
            ...(isBot ? { isBot: true as const } : {}),
        });
    }

    isBot(playerId: string): boolean {
        return this.state.players.get(playerId)?.isBot === true;
    }

    
    currentRound(): RoundState | undefined {
        return this.state.rounds.get(this.state.round);
    }

    abandonCurrentRound(): void {
        const round = this.currentRound();
        if (round?.status === "in_progress") {
            round.status = "abandoned";
        }
    }
    
startRound(playerIds: string[] = []): boolean {
    if (this.state.phase !== "lobby") {
        return false;
    }

    this.state.round++;

    const uniquePlayerIds = [...new Set(playerIds)];
    const botPlayerIds = uniquePlayerIds.filter(id => this.isBot(id));
    const round: RoundState = {
        status: "in_progress",
        startedAt: new Date(),
        completedAt: null,
        prompt: this.randomPrompt(),
        wordsAvailable: new Map(
            uniquePlayerIds.map(id => [id, dealWords()]),
        ),
        playerIds: uniquePlayerIds,
        answers: [],
        rankings: new Map<string, Ranking>(),
        ...(botPlayerIds.length > 0 ? { botPlayerIds } : {}),
    };

    this.state.rounds.set(this.state.round, round);
    this.state.phase = "answering";

    return true;
}
    
    
    // Replace a bot's hand before it answers, so its planned answer is made of dealt words.
    redealHand(playerId: string, requiredWords: string[]): boolean {
        const round = this.currentRound();
        if (
            this.state.phase !== "answering"
            || !round
            || !round.wordsAvailable.has(playerId)
            || round.answers.some(answer => answer.playerId === playerId)
        ) {
            return false;
        }

        round.wordsAvailable.set(playerId, dealWords(requiredWords));
        return true;
    }

    submitAnswer(
        playerId: string,
        words: string[],
        origin?: AnswerOrigin,
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
        
        const availableWords = round.wordsAvailable.get(playerId);
        if (!availableWords || !this.validateWords(words, availableWords)) {
            return undefined;
        }
        
        const answer: Answer = {
            id: crypto.randomUUID(),
            playerId,
            words,
            receivedAt: new Date(),
            ...origin,
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
        const totalAnswers = ranking.answerIds.length;

        ranking.answerIds.forEach((answerId, index) => {
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
    
}
