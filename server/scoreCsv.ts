import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoundPrediction } from "./types.js";

export type ScoreRound = {
    roundNumber: number;
    status: string;
    prompt: string;
    completedAt?: Date | string | null;
    answers: { answerId: string; playerId: string; words: string[] }[];
    scores?: { answerId: string; score: number }[];
    prediction?: RoundPrediction;
};
export type ScoreGame = {
    _id: string;
    roomId?: string;
    state: { players?: { playerId: string; name: string }[]; rounds: ScoreRound[] };
};
type Cell = string | number | null | undefined;

function csv(rows: Cell[][]): string {
    return rows.map(row => row.map(value => {
        const text = value == null ? "" : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    }).join(",")).join("\r\n") + "\r\n";
}

function completedAt(round: ScoreRound): string {
    if (!round.completedAt) return "";
    const date = new Date(round.completedAt);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function accuracy(actual: number[], predicted: number[]) {
    const levels = [...new Set(actual)].sort((a, b) => a - b);
    const relevance = actual.map(score => levels.indexOf(score));
    const indexes = actual.map((_, index) => index).sort((a, b) => predicted[b] - predicted[a]);
    const gain = (index: number) => 2 ** relevance[index] - 1;
    let dcg = 0;
    for (let position = 0; position < Math.min(3, indexes.length); position++) {
        // Average tied predictions rather than using submission order as a tiebreaker.
        const tied = indexes.filter(index => predicted[index] === predicted[indexes[position]]);
        dcg += tied.reduce((sum, index) => sum + gain(index), 0) / tied.length / Math.log2(position + 2);
    }
    const ideal = actual.map((_, i) => i).sort((a, b) => actual[b] - actual[a]).slice(0, 3)
        .reduce((sum, index, position) => sum + gain(index) / Math.log2(position + 2), 0);
    let pairs = 0, correct = 0;
    for (let i = 0; i < actual.length; i++) for (let j = i + 1; j < actual.length; j++) {
        if (actual[i] === actual[j]) continue;
        pairs++;
        correct += predicted[i] === predicted[j] ? 0.5 : Number((actual[i] - actual[j]) * (predicted[i] - predicted[j]) > 0);
    }
    const predictedWinners = indexes.filter(i => predicted[i] === Math.max(...predicted));
    const top1 = predictedWinners.filter(i => actual[i] === Math.max(...actual)).length / predictedWinners.length;
    return { ndcg: ideal ? dcg / ideal : 1, pairs, correct, top1 };
}

export function buildScoreCsv(games: ScoreGame[]): { scores: string; accuracy: string } {
    const scoreRows: Cell[][] = [["completed_at", "game_id", "room_id", "round_number", "prompt", "answer_id",
        "player_id", "player_name", "answer", "human_score", "human_rank", "game_total", "all_games_total",
        "ai_score", "ai_rank"]];
    const accuracyRows: Cell[][] = [["completed_at", "game_id", "room_id", "round_number", "answers",
        "has_prediction", "ndcg_at_3", "pairwise_accuracy", "top1_accuracy", "completed_rounds",
        "evaluated_rounds", "cumulative_ndcg_at_3", "cumulative_pairwise_accuracy", "cumulative_top1_accuracy"]];
    const rounds = games.flatMap(game => game.state.rounds.filter(round => round.status === "completed")
        .map(round => ({ game, round }))).sort((a, b) => completedAt(a.round).localeCompare(completedAt(b.round))
            || a.game._id.localeCompare(b.game._id) || a.round.roundNumber - b.round.roundNumber);
    const seen = new Set<string>();
    const globalTotals = new Map<string, number>();
    const gameTotals = new Map<string, number>();
    let completed = 0, evaluated = 0, ndcgSum = 0, top1Sum = 0, pairs = 0, correct = 0;
    for (const { game, round } of rounds) {
        const key = JSON.stringify([game._id, round.roundNumber]);
        if (seen.has(key)) continue;
        seen.add(key);
        const scores = new Map((round.scores ?? []).map(row => [row.answerId, row.score]));
        if (!round.answers.length || round.answers.some(answer => !Number.isFinite(scores.get(answer.answerId)))) continue;
        const actual = round.answers.map(answer => scores.get(answer.answerId)!);
        const predicted = new Map((round.prediction?.status === "ready" ? round.prediction.answers : [])
            .map(row => [row.answerId, row.score]));
        const hasPrediction = predicted.size === round.answers.length
            && round.answers.every(answer => Number.isFinite(predicted.get(answer.answerId)));
        const predictionScores = round.answers.map(answer => predicted.get(answer.answerId)!);
        completed++;
        const metrics = hasPrediction ? accuracy(actual, predictionScores) : null;
        if (metrics) {
            evaluated++;
            ndcgSum += metrics.ndcg;
            top1Sum += metrics.top1;
            pairs += metrics.pairs;
            correct += metrics.correct;
        }
        const prefix: Cell[] = [completedAt(round), game._id, game.roomId, round.roundNumber];
        accuracyRows.push([...prefix, round.answers.length, hasPrediction ? 1 : 0,
            metrics?.ndcg, metrics && metrics.pairs ? metrics.correct / metrics.pairs : null, metrics?.top1,
            completed, evaluated, evaluated ? ndcgSum / evaluated : null,
            pairs ? correct / pairs : null, evaluated ? top1Sum / evaluated : null]);
        for (const [index, answer] of round.answers.entries()) {
            const score = actual[index];
            const playerGame = JSON.stringify([game._id, answer.playerId]);
            const total = (globalTotals.get(answer.playerId) ?? 0) + score;
            const gameTotal = (gameTotals.get(playerGame) ?? 0) + score;
            globalTotals.set(answer.playerId, total);
            gameTotals.set(playerGame, gameTotal);
            scoreRows.push([...prefix, round.prompt, answer.answerId, answer.playerId,
                game.state.players?.find(player => player.playerId === answer.playerId)?.name,
                answer.words.join(" "), score, 1 + actual.filter(other => other > score).length, gameTotal, total,
                hasPrediction ? predictionScores[index] : null,
                hasPrediction ? 1 + predictionScores.filter(other => other > predictionScores[index]).length : null]);
        }
    }
    return { scores: csv(scoreRows), accuracy: csv(accuracyRows) };
}

export function scoreLogDirectory(): string {
    return process.env.SCORE_LOG_DIR ? resolve(process.env.SCORE_LOG_DIR)
        : fileURLToPath(new URL("../logs/", import.meta.url));
}

export class ScoreCsvLog {
    private pending: Promise<void> = Promise.resolve();
    constructor(private snapshot: () => Promise<ScoreGame[]>, private directory = scoreLogDirectory()) {}

    refresh(): Promise<void> {
        const write = this.pending.catch(() => {}).then(async () => {
            const output = buildScoreCsv(await this.snapshot());
            await mkdir(this.directory, { recursive: true });
            for (const [file, contents] of [["round-scores.csv", output.scores], ["model-accuracy.csv", output.accuracy]]) {
                const destination = join(this.directory, file);
                const temporary = `${destination}.${randomUUID()}.tmp`;
                try {
                    await writeFile(temporary, contents, "utf8");
                    await rename(temporary, destination);
                } finally { await rm(temporary, { force: true }); }
            }
        });
        this.pending = write;
        return write;
    }

    async flush(): Promise<void> { await this.pending; }
}
