import { getDatabase } from "./db.js";

const PARTICIPANTS_COLLECTION_NAME = "participants";
const CONSENT_VERSION = "2026-10-19";

type Participant = {
    _id: string;
    consentedAt: Date;
    consentVersion: string;
};

function participants() {
    return getDatabase().collection<Participant>(PARTICIPANTS_COLLECTION_NAME);
}

export async function hasConsented(playerId: string): Promise<boolean> {
    return (await participants().findOne(
        { _id: playerId },
        { projection: { _id: 1 } },
    )) !== null;
}

export async function recordConsent(playerId: string): Promise<void> {
    await participants().updateOne(
        { _id: playerId },
        {
            $setOnInsert: {
                consentedAt: new Date(),
                consentVersion: CONSENT_VERSION,
            },
        },
        { upsert: true },
    );
}