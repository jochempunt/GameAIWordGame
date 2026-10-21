import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is missing; configure .env first.");

const output = resolve(process.argv[2] ?? "ml/humor/data/games.json");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });

try {
    await client.connect();
    // Export only saved games, using the same collection as gameRepository.ts.
    const games = await client.db("wordgame").collection("games").find({}).toArray();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(games, null, 2) + "\n", "utf8");
    console.log(`Exported ${games.length} saved games to ${output}`);
} catch (error) {
    // Mongo errors can contain connection details; keep credentials out of logs.
    console.error(`Game export failed (${error instanceof Error ? error.name : "unknown error"}). Check MongoDB, .env, and the output path.`);
    process.exitCode = 1;
} finally {
    await client.close();
}
