import { FieldValue } from "firebase-admin/firestore";
import { getFirestore } from "./backup.js";

// Denormalized activeUsers/inactiveUsers Firestore collections, kept
// alongside (not instead of) the operational users.json/Firestore "users"
// backup in backup.js. Purpose: a future admin dashboard can read "who is
// active" / "who is inactive" as one flat collection query, rather than
// filtering the single users blob by a status field every time. Every
// function here degrades gracefully (logs only) when Firestore isn't
// configured, same pattern as the rest of the app's optional integrations.
//
// Document ID is the user's waId in both collections, so a user only ever
// exists in exactly one of the two at a time — moving between them is a
// write to one collection plus a delete from the other, not a status flag
// flip within a single doc (deliberately, so a raw collection listing is
// immediately correct without a client having to filter/interpret a field).

function snapshotFields({ waId, emailAddress, folder, onboardedAt, dashboardToken }) {
  return { waId, emailAddress: emailAddress || null, folder: folder || null, onboardedAt: onboardedAt || null, dashboardToken: dashboardToken || null };
}

export async function recordActiveUser(user) {
  const db = getFirestore();
  if (!db) return;
  try {
    await db.collection("activeUsers").doc(user.waId).set({
      ...snapshotFields(user),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db.collection("inactiveUsers").doc(user.waId).delete().catch(() => {});
  } catch (err) {
    console.error(`[userDirectory] failed to record active user ${user.waId}:`, err.message || err);
  }
}

export async function recordInactiveUser(user, reason = "unsubscribed") {
  const db = getFirestore();
  if (!db) return;
  try {
    await db.collection("inactiveUsers").doc(user.waId).set({
      ...snapshotFields(user),
      reason,
      unsubscribedAt: FieldValue.serverTimestamp(),
    });
    await db.collection("activeUsers").doc(user.waId).delete();
  } catch (err) {
    console.error(`[userDirectory] failed to record inactive user ${user.waId}:`, err.message || err);
  }
}
