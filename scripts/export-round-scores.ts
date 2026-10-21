import { connectToDatabase, disconnectFromDatabase, getDatabase } from "../server/database/db.js";
import { ScoreCsvLog, scoreLogDirectory } from "../server/scoreCsv.js";
import type { ScoreGame } from "../server/scoreCsv.js";

try {
    await connectToDatabase();
    const log = new ScoreCsvLog(() => getDatabase().collection<ScoreGame>("games").find({ "state.rounds.status": "completed" }).toArray());
    await log.refresh();
    console.log(`Updated round-scores.csv and model-accuracy.csv in ${scoreLogDirectory()}`);
} catch {
    console.error("Could not export score CSVs. Check MongoDB, .env, and the log directory.");
    process.exitCode = 1;
} finally { await disconnectFromDatabase(); }
