import { MongoClient } from "mongodb";

// Remove only player display names from existing game documents.
// Run: node --env-file=.env scripts/remove-stored-player-names.mjs
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is missing");
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
try {
    await client.connect();
    const games = client.db("wordgame").collection("games");
    const result = await games.updateMany(
        { "state.players.name": { $exists: true } },
        { $unset: { "state.players.$[].name": "" } },
    );
    console.log(`Removed player names from ${result.modifiedCount} game documents.`);
    const remaining = await games.countDocuments({ "state.players.name": { $exists: true } });
    if (remaining !== 0) throw new Error(`${remaining} game documents still contain player names`);
    console.log("Verified: no saved game player names remain.");
} finally {
    await client.close();
}
