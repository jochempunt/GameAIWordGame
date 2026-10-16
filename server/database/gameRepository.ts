import { getDatabase } from "./db.js";
import { Game } from "../game.js";
import type { Answer, GamePlayer, GameState, Ranking, RoundState } from "../types.js";

const GAMES_COLLECTION_NAME = "games";

type StoredRound = Omit<RoundState, "answers" | "rankings" | "scores" | "playerIds" | "status" | "startedAt" | "completedAt"> & {
  playerIds?: string[];
  status?: RoundState["status"];
  startedAt?: Date | null;
  completedAt?: Date | null;
  answers: (Omit<Answer, "receivedAt"> & { receivedAt?: Date | null })[];
  rankings: [string, Ranking | string[]][];
  scores?: [string, number][];
};

type StoredGame = {
  _id: string;
  roomId?: string;
  state: Omit<GameState, "players" | "rounds" | "totals"> & {
    players?: [string, GamePlayer][];
    rounds: [number, StoredRound][];
    totals: [string, number][];
  };
};

const pendingSaves = new Map<string, Promise<unknown>>();

function getGamesCollection() {
  return getDatabase().collection<StoredGame>(GAMES_COLLECTION_NAME);
}

/** Saves sessions that have started a round; returns null for unplayed lobbies. */
export async function saveGame(game: Game, roomId?: string): Promise<string | null> {
  if (game.state.rounds.size === 0) return null;

  // Capture mutable arrays and Maps now, before waiting for an earlier write.
  const document: StoredGame = structuredClone({
    _id: game.id,
    ...(roomId === undefined ? {} : { roomId }),
    state: {
      ...game.state,
      players: [...game.state.players],
      totals: [...game.state.totals],
      rounds: [...game.state.rounds].map(([number, round]) => [number, {
        ...round,
        rankings: [...round.rankings],
        scores: round.scores ? [...round.scores] : undefined,
      }]),
    },
  });
  
  // Keep writes ordered within a session, while separate rooms save independently.
  const previous = pendingSaves.get(game.id) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() =>
    getGamesCollection().replaceOne(
      { _id: game.id },
      document,
      { upsert: true },
    ),
  );
  pendingSaves.set(game.id, write);
  try {
    await write;
  } finally {
    if (pendingSaves.get(game.id) === write) pendingSaves.delete(game.id);
  }
  
  return game.id;
}

export async function flushGameSaves(): Promise<void> {
  await Promise.all(pendingSaves.values());
}

/** loads game with its methods and Maps restored, or null if it doesnt exist. */
export async function getGame(id: string): Promise<Game | null> {
  const document = await getGamesCollection().findOne({ _id: id });
  if (!document) return null;
  
  const game = new Game(document._id);
  game.state = {
    ...document.state,
    players: new Map(document.state.players ?? []),
    totals: new Map(document.state.totals),
    rounds: new Map(document.state.rounds.map(([number, round]) => [number, {
      ...round,
      // Older documents have no timestamps; do not invent historical dates.
      startedAt: round.startedAt ?? null,
      completedAt: round.completedAt ?? null,
      status: round.status ?? (round.scores
        ? "completed"
        : number === document.state.round &&
          (document.state.phase === "answering" || document.state.phase === "ranking")
          ? "in_progress"
          : "abandoned"),
      playerIds: round.playerIds ?? [],
      answers: round.answers.map(answer => ({
        ...answer,
        receivedAt: answer.receivedAt ?? null,
      })),
      rankings: new Map(round.rankings.map(([playerId, ranking]) => [playerId,
        Array.isArray(ranking)
          ? { answerIds: ranking, receivedAt: null }
          : { ...ranking, receivedAt: ranking.receivedAt ?? null },
      ])),
      scores: round.scores ? new Map(round.scores) : undefined,
    }])),
  };
  
  return game;
}
