import { getDatabase } from "./db.js";
import type { ReusableAnswer, ReusableAnswerStore } from "../bots/answerSources.js";

// Human answers collected from bot-assisted rounds, for bots to present in later rounds.
// Separate from `games`: the research rounds stay as they were played.
const REUSABLE_ANSWERS_COLLECTION_NAME = "reusable_answers";

type StoredReusableAnswer = Omit<ReusableAnswer, "id"> & { _id: string };

function reusableAnswers() {
  return getDatabase().collection<StoredReusableAnswer>(REUSABLE_ANSWERS_COLLECTION_NAME);
}

export async function loadReusableAnswers(): Promise<ReusableAnswer[]> {
  await reusableAnswers().createIndex({ prompt: 1 });
  await reusableAnswers().createIndex({ authorId: 1 });

  const documents = await reusableAnswers().find().toArray();
  return documents.map(({ _id, ...answer }) => ({ id: _id, ...answer }));
}

export const reusableAnswerStore: ReusableAnswerStore = {
  async insert(answers) {
    // The id is derived from author, prompt and words, so a repeated answer is stored once.
    await reusableAnswers().bulkWrite(answers.map(({ id, usageCount, lastUsedAt, ...answer }) => ({
      updateOne: {
        filter: { _id: id },
        update: { $setOnInsert: { ...answer, usageCount, lastUsedAt } },
        upsert: true,
      },
    })));
  },

  async recordUse(id, at) {
    await reusableAnswers().updateOne(
      { _id: id },
      { $inc: { usageCount: 1 }, $set: { lastUsedAt: at } },
    );
  },
};
