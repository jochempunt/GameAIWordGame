import { getDatabase } from "./db.js";
import { Game } from "../game.js";
import type { GamePlayer, GameState, RoundState } from "../types.js";

const GAMES_COLLECTION_NAME = "games";

type StoredRound = Omit<RoundState, "rankings" | "scores" | "playerIds"> & {
  playerIds?: string[];
  rankings: [string, string[]][];
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

/** creates or updates a game using ID. returns saved games ID. */
export async function saveGame(game: Game, roomId?: string): Promise<string> {
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
      playerIds: round.playerIds ?? [],
      rankings: new Map(round.rankings),
      scores: round.scores ? new Map(round.scores) : undefined,
    }])),
  };
  
  return game;
}
