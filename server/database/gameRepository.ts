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
  state: Omit<GameState, "players" | "rounds" | "totals"> & {
    players?: [string, GamePlayer][];
    rounds: [number, StoredRound][];
    totals: [string, number][];
  };
};

function getGamesCollection() {
  return getDatabase().collection<StoredGame>(GAMES_COLLECTION_NAME);
}

/** creates or updates a game using ID. returns saved games ID. */
export async function saveGame(game: Game): Promise<string> {
  const document: StoredGame = {
    _id: game.id,
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
  };
  
  await getGamesCollection().replaceOne(
    { _id: game.id },
    document,
    { upsert: true },
  );
  
  return game.id;
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
