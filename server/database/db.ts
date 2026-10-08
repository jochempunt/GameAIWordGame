import { MongoClient, type Db } from "mongodb";

const DATABASE_NAME = "wordgame";

const uri = process.env.MONGODB_URI;

if (!uri) {
    throw new Error("MONGODB_URI is missing");
}

const client = new MongoClient(uri);
let database: Db | null = null;


export async function connectToDatabase(): Promise<void> {
    await client.connect();
    
    database = client.db(DATABASE_NAME);
    
    await database.command({ ping: 1 });
    
    console.log(`Connected to MongoDB database: ${DATABASE_NAME}`);
}



export function getDatabase(): Db {
    if (!database) {
        throw new Error("Database connection is not established. Call connectToDatabase() first.");
    }
    
    return database;
    
}


export async function disconnectFromDatabase(): Promise<void> {
    await client.close();
    database = null;
    
    console.log("Disconnected from MongoDB");
}