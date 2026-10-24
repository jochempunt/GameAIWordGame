import { createHash } from "node:crypto";
import type { Game } from "../game.js";
import type { ReusableAnswer } from "../bots/answerSources.js";
import type {
  Answer,
  AnswerProvenance,
  GamePlayer,
  GameState,
  Ranking,
  RoundState,
} from "../types.js";

// Kept free of database access so the research rules can be tested on their own.

/**
 * - human_only: no bots took part; stored exactly as before bots existed.
 * - bot_assisted: bots only presented reused human answers; still a research round.
 * - synthetic: at least one pre-generated or random bot answer; excluded from `games`.
 * - bot_only: no human took part; not stored at all.
 */
export type RoundKind = "human_only" | "bot_assisted" | "synthetic" | "bot_only";

export type ExclusionReason = "synthetic_bot_answers" | "no_human_participants";

export type StoredAnswer = Omit<Answer, "id" | "provenance"> & {
  answerId: string;
  provenance?: AnswerProvenance;
};

export type StoredRanking = Omit<Ranking, "isBot"> & { playerId: string; isBot?: boolean };

export type StoredRound = Omit<RoundState, "wordsAvailable" | "rankings" | "scores" | "answers"> & {
  roundNumber: number;
  wordsAvailable: { playerId: string; words: string[] }[];
  answers: StoredAnswer[];
  rankings: StoredRanking[];
  scores?: { answerId: string; score: number }[];
  // Only on rounds bots took part in; absent means a human-only round, as in older records.
  research?: { botAssisted: true; eligible: boolean; reason?: ExclusionReason };
};

export type StoredPlayer = Omit<GamePlayer, "id"> & { playerId: string };

export type StoredGame = {
  _id: string;
  roomId?: string;
  state: Omit<GameState, "players" | "rounds" | "totals"> & {
    players: StoredPlayer[];
    rounds: StoredRound[];
    totals: { playerId: string; score: number }[];
  };
  // Round numbers left out of `state.rounds`, so gaps in the numbering are explained.
  excludedRounds?: { roundNumber: number; reason: ExclusionReason }[];
};

/** A bot-assisted round with synthetic answers, kept apart from the research dataset. */
export type StoredSyntheticRound = StoredRound & {
  _id: string; // roundId()
  gameId: string;
  roomId?: string;
  players: StoredPlayer[];
};

export function roundId(gameId: string, roundNumber: number): string {
  return `${gameId}:${roundNumber}`;
}

function isSyntheticAnswer(answer: Answer): boolean {
  return answer.provenance === "bot_pregenerated" || answer.provenance === "bot_random";
}

export function classifyRound(round: RoundState): RoundKind {
  const bots = new Set(round.botPlayerIds ?? []);
  const hasHuman = round.playerIds.some(id => !bots.has(id));
  const synthetic = round.containsSyntheticAnswers === true || round.answers.some(isSyntheticAnswer);

  if (!hasHuman) return "bot_only";
  if (synthetic) return "synthetic";
  return bots.size === 0 ? "human_only" : "bot_assisted";
}

function storeRound(roundNumber: number, round: RoundState, kind: RoundKind): StoredRound {
  const stored: StoredRound = {
    roundNumber,
    ...round,
    wordsAvailable: [...round.wordsAvailable].map(([playerId, words]) => ({ playerId, words })),
    answers: round.answers.map(({ id, ...answer }) => ({ answerId: id, ...answer })),
    rankings: [...round.rankings].map(([playerId, ranking]) => ({ playerId, ...ranking })),
    scores: round.scores
      ? [...round.scores].map(([answerId, score]) => ({ answerId, score }))
      : undefined,
  };
  if (kind === "human_only") return stored;

  // Bot-assisted rounds spell out every contribution's origin, so human and bot data can be filtered apart.
  const bots = new Set(round.botPlayerIds ?? []);
  return {
    ...stored,
    answers: stored.answers.map(answer => ({ ...answer, provenance: answer.provenance ?? "human_original" })),
    rankings: stored.rankings.map(ranking => ({ ...ranking, isBot: bots.has(ranking.playerId) })),
    research: kind === "synthetic"
      ? { botAssisted: true, eligible: false, reason: "synthetic_bot_answers" }
      : { botAssisted: true, eligible: true },
  };
}

function storePlayers(players: Iterable<GamePlayer>): StoredPlayer[] {
  return [...players].map(({ id, ...player }) => ({ playerId: id, ...player }));
}

/** Splits a game into its research document (null if it has no research rounds) and its synthetic rounds. */
export function buildGameRecords(game: Game, roomId?: string): {
  game: StoredGame | null;
  syntheticRounds: StoredSyntheticRound[];
} {
  const researchRounds: StoredRound[] = [];
  const syntheticRounds: StoredSyntheticRound[] = [];
  const excludedRounds: NonNullable<StoredGame["excludedRounds"]> = [];
  const roomField = roomId === undefined ? {} : { roomId };

  for (const [roundNumber, round] of game.state.rounds) {
    const kind = classifyRound(round);

    if (kind === "bot_only") {
      excludedRounds.push({ roundNumber, reason: "no_human_participants" });
    } else if (kind === "synthetic") {
      excludedRounds.push({ roundNumber, reason: "synthetic_bot_answers" });
      syntheticRounds.push({
        _id: roundId(game.id, roundNumber),
        gameId: game.id,
        ...roomField,
        players: storePlayers(round.playerIds.flatMap(id => game.state.players.get(id) ?? [])),
        ...storeRound(roundNumber, round, kind),
      });
    } else {
      researchRounds.push(storeRound(roundNumber, round, kind));
    }
  }

  const document: StoredGame | null = researchRounds.length === 0 ? null : {
    _id: game.id,
    ...roomField,
    state: {
      ...game.state,
      players: storePlayers(game.state.players.values()),
      // totals only cover the stored rounds, so excluded rounds leave no trace in them
      totals: excludedRounds.length === 0
        ? [...game.state.totals].map(([playerId, score]) => ({ playerId, score }))
        : totalsFor(researchRounds),
      rounds: researchRounds,
    },
    ...(excludedRounds.length > 0 ? { excludedRounds } : {}),
  };

  // Capture mutable arrays and Maps now, before waiting for an earlier write.
  return structuredClone({ game: document, syntheticRounds });
}

function totalsFor(rounds: StoredRound[]): { playerId: string; score: number }[] {
  const totals = new Map<string, number>();
  for (const round of rounds) {
    const scores = new Map((round.scores ?? []).map(({ answerId, score }) => [answerId, score]));
    for (const answer of round.answers) {
      if (!scores.has(answer.answerId)) continue;
      totals.set(answer.playerId, (totals.get(answer.playerId) ?? 0) + scores.get(answer.answerId)!);
    }
  }
  return [...totals].map(([playerId, score]) => ({ playerId, score }));
}

export function reusableAnswerId(authorId: string, prompt: string, words: string[]): string {
  return createHash("sha256").update(JSON.stringify([authorId, prompt, words])).digest("hex");
}

/** Original human answers from a finished bot-assisted round, ready for the reusable pool. */
export function collectReusableAnswers(
  game: Game,
  roundNumber: number,
  minWords: number,
  now: Date = new Date(),
): ReusableAnswer[] {
  const round = game.state.rounds.get(roundNumber);
  if (!round || round.status !== "completed" || !round.botPlayerIds?.length) return [];

  const bots = new Set(round.botPlayerIds);
  return round.answers
    .filter(answer => answer.provenance === undefined && !bots.has(answer.playerId))
    .filter(answer => answer.words.length >= minWords)
    .map(answer => ({
      id: reusableAnswerId(answer.playerId, round.prompt, answer.words),
      prompt: round.prompt,
      words: [...answer.words],
      authorId: answer.playerId,
      sourceGameId: game.id,
      sourceRoundNumber: roundNumber,
      sourceRoundId: roundId(game.id, roundNumber),
      sourceAnswerId: answer.id,
      collectedAt: now,
      usageCount: 0,
      lastUsedAt: null,
    }));
}
