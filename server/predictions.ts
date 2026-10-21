import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Game } from "./game.js";
import type { RoundPrediction, RoundState } from "./types.js";

export type PredictionTask = {
    inputs: {
        prompt: string;
        candidates: {
            answer_id: string;
            player_id: string;
            answer_tokens: string[];
            available_words: string[];
        }[];
    };
};

export type HumorPredictor = {
    predictTask(task: PredictionTask): { answer_id: string; score: number }[];
};

export function humorModelPath(): string {
    return process.env.HUMOR_MODEL_PATH
        ? resolve(process.env.HUMOR_MODEL_PATH)
        : fileURLToPath(new URL("../ml/humor/artifacts/model/humor_ranker.cjs", import.meta.url));
}

export function readHumorPredictor(path: string): HumorPredictor {
    // Read this self-contained scorer as data so node --watch does not restart
    // the game whenever background training replaces the generated file.
    const context = { module: { exports: {} as HumorPredictor } };
    new Script(readFileSync(path, "utf8"), { filename: path }).runInNewContext(context, { timeout: 1000 });
    const model = context.module.exports;
    if (typeof model.predictTask !== "function") throw new Error("Missing predictTask API");
    return model;
}

export function loadHumorPredictor(): HumorPredictor | null {
    try {
        const model = readHumorPredictor(humorModelPath());
        console.log("Humor prediction model loaded");
        return model;
    } catch {
        console.warn("No humor model loaded yet. Background training can create one after six eligible rounds.");
        return null;
    }
}

export function predictRound(round: RoundState, model: HumorPredictor | null): RoundPrediction {
    if (!model || round.answers.length < 3) return { status: "unavailable", answers: [] };
    try {
        // No rankings, final scores, or player names are passed to inference.
        const candidates = round.answers.map(answer => ({
            answer_id: answer.id,
            player_id: answer.playerId,
            answer_tokens: [...answer.words],
            available_words: [...(round.wordsAvailable.get(answer.playerId) ?? [])],
        }));
        const output = model.predictTask({ inputs: { prompt: round.prompt, candidates } });
        const ids = new Set(round.answers.map(answer => answer.id));
        if (output.length !== ids.size || new Set(output.map(row => row.answer_id)).size !== ids.size
            || output.some(row => !ids.has(row.answer_id) || !Number.isFinite(row.score))) {
            throw new Error("Invalid model predictions");
        }
        const sorted = [...output].sort((a, b) => b.score - a.score || a.answer_id.localeCompare(b.answer_id));
        return {
            status: "ready",
            answers: sorted.map(row => ({
                answerId: row.answer_id,
                score: row.score,
                rank: 1 + sorted.filter(other => other.score > row.score).length,
            })),
        };
    } catch {
        console.warn("Humor prediction failed for this round");
        return { status: "unavailable", answers: [] };
    }
}

export const PREDICTION_DURATION_MS = 5000;

export function startPredictionReview(game: Game, requiredPlayers: string[], model: HumorPredictor | null, now = Date.now()): boolean {
    const round = game.currentRound();
    if (game.state.phase !== "answering" || !round || requiredPlayers.length === 0
        || !requiredPlayers.every(id => round.answers.some(answer => answer.playerId === id))) return false;
    round.prediction = predictRound(round, model);
    round.predictionEndsAt = now + PREDICTION_DURATION_MS;
    game.state.phase = "prediction";
    return true;
}

export function finishPredictionReview(game: Game, now = Date.now()): boolean {
    const endsAt = game.currentRound()?.predictionEndsAt;
    if (game.state.phase !== "prediction" || endsAt === undefined || now < endsAt) return false;
    game.state.phase = "ranking";
    return true;
}
