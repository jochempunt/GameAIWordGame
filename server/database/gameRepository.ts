import { getDatabase } from "./db.js";
import { Game } from "../game.js";
import { buildGameRecords } from "./researchRecords.js";
import type { StoredGame, StoredSyntheticRound } from "./researchRecords.js";

const GAMES_COLLECTION_NAME = "games";
// Bot-assisted rounds with synthetic answers: marked, and kept out of the research games.
const SYNTHETIC_ROUNDS_COLLECTION_NAME = "synthetic_rounds";

const pendingSaves = new Map<string, Promise<unknown>>();

function getGamesCollection() {
  return getDatabase().collection<StoredGame>(GAMES_COLLECTION_NAME);
}

function getSyntheticRoundsCollection() {
  return getDatabase().collection<StoredSyntheticRound>(SYNTHETIC_ROUNDS_COLLECTION_NAME);
}

/**
 * Saves sessions with at least one research round; returns null when there is none
 * (unplayed lobbies, or only synthetic and bot-only rounds). Synthetic rounds that a
 * human took part in go to their own collection.
 */
export async function saveGame(game: Game, roomId?: string): Promise<string | null> {
  const records = buildGameRecords(game, roomId);
  if (!records.game && records.syntheticRounds.length === 0) return null;

  // Keep writes ordered within a session, while separate rooms save independently.
  const previous = pendingSaves.get(game.id) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    if (records.game) {
      await getGamesCollection().replaceOne(
        { _id: game.id },
        records.game,
        { upsert: true },
      );
    }
    if (records.syntheticRounds.length > 0) {
      await getSyntheticRoundsCollection().bulkWrite(records.syntheticRounds.map(round => ({
        replaceOne: { filter: { _id: round._id }, replacement: round, upsert: true },
      })));
    }
  });
  pendingSaves.set(game.id, write);
  try {
    await write;
  } finally {
    if (pendingSaves.get(game.id) === write) pendingSaves.delete(game.id);
  }

  return records.game ? game.id : null;
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
    rounds: new Map(document.state.rounds.map(({ roundNumber, research: _research, ...round }) => [roundNumber, {
      ...round,
      wordsAvailable: new Map(round.wordsAvailable.map(({ playerId, words }) => [playerId, words])),
      answers: round.answers.map(({ answerId, provenance, ...answer }) => ({
        id: answerId,
        ...answer,
        ...(provenance && provenance !== "human_original" ? { provenance } : {}),
      })),
      rankings: new Map(round.rankings.map(({ playerId, isBot, ...ranking }) => [
        playerId, { ...ranking, ...(isBot ? { isBot: true as const } : {}) },
      ])),
      scores: round.scores
        ? new Map(round.scores.map(({ answerId, score }) => [answerId, score]))
        : undefined,
    }])),
  };

  return game;
}
