import { getDatabase } from "./db.js";

// Audit trail of moderation actions, kept apart from the research data.
const ADMIN_ACTIONS_COLLECTION_NAME = "admin_actions";

export type AdminAction = {
  adminId: string;
  action: string;
  roomId?: string;
  targetPlayerId?: string;
  details?: Record<string, unknown>;
  at: Date;
};

export function recordAdminAction(action: Omit<AdminAction, "at">): void {
  console.log(
    `Admin ${action.adminId.slice(0, 12)}: ${action.action}`
      + (action.roomId ? ` in room ${action.roomId}` : "")
      + (action.targetPlayerId ? ` on ${action.targetPlayerId.slice(0, 12)}` : ""),
  );
  getDatabase()
    .collection<AdminAction>(ADMIN_ACTIONS_COLLECTION_NAME)
    .insertOne({ ...action, at: new Date() })
    .catch(error => console.error("Could not record admin action:", error));
}
