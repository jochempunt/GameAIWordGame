import { getDatabase } from "./db.js";
import { Game } from "../game.js";
import type { Answer, GamePlayer, GameState, Ranking, RoundState } from "../types.js";

const GAMES_COLLECTION_NAME = "games";

type StoredRound = Omit<RoundState, "wordsAvailable" | "rankings" | "scores" | "answers"> & {
  roundNumber: number;
  wordsAvailable: { playerId: string; words: string[] }[];
  answers: (Omit<Answer, "id"> & { answerId: string })[];
  rankings: (Ranking & { playerId: string })[];
  scores?: { answerId: string; score: number }[];
};

type StoredGame = {
  _id: string;
  roomId?: string;
  state: Omit<GameState, "players" | "rounds" | "totals"> & {
    players: (Omit<GamePlayer, "id"> & { playerId: string })[];
    rounds: StoredRound[];
    totals: { playerId: string; score: number }[];
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
      players: [...game.state.players.values()].map(({ id, ...player }) => ({
        playerId: id, ...player,
      })),
      totals: [...game.state.totals].map(([playerId, score]) => ({ playerId, score })),
      rounds: [...game.state.rounds].map(([roundNumber, round]) => ({
        roundNumber,
        ...round,
        wordsAvailable: [...round.wordsAvailable].map(([playerId, words]) => ({ playerId, words })),
        answers: round.answers.map(({ id, ...answer }) => ({ answerId: id, ...answer })),
        rankings: [...round.rankings].map(([playerId, ranking]) => ({ playerId, ...ranking })),
        scores: round.scores
          ? [...round.scores].map(([answerId, score]) => ({ answerId, score }))
          : undefined,
      })),
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
    players: new Map(document.state.players.map(({ playerId, ...player }) => [
      playerId, { id: playerId, ...player },
    ])),
    totals: new Map(document.state.totals.map(({ playerId, score }) => [playerId, score])),
    rounds: new Map(document.state.rounds.map(({ roundNumber, ...round }) => [roundNumber, {
      ...round,
      wordsAvailable: new Map(round.wordsAvailable.map(({ playerId, words }) => [playerId, words])),
      answers: round.answers.map(({ answerId, ...answer }) => ({ id: answerId, ...answer })),
      rankings: new Map(round.rankings.map(({ playerId, ...ranking }) => [playerId, ranking])),
      scores: round.scores
        ? new Map(round.scores.map(({ answerId, score }) => [answerId, score]))
        : undefined,
    }])),
  };
  
  return game;
}
