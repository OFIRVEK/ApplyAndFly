import fs from "fs";
import admin from "firebase-admin";
import { config } from "./config.js";

// Reuses the same Google account already used for OAuth (Firebase attaches
// to an existing Google Cloud project) rather than an unrelated new
// service, and — unlike Cloud Storage — Firebase's free Spark plan needs no
// payment method on file. Every function here degrades gracefully — logs
// and no-ops — when it isn't configured, so the app keeps working on
// local-disk-only storage exactly as before if this hasn't been set up.
//
// Each JSON file is stored as a single Firestore document (collection
// "backups", document ID = the same name passed in, e.g. "applications.json")
// holding the whole array under a "records" field — this mirrors the old
// GCS blob-upload approach and keeps this module's external interface
// (restoreAndMerge/backupFile) completely unchanged for its callers.
let firestore = null;

function getFirestore() {
  if (!config.firebase.serviceAccountKey) return null;
  if (!firestore) {
    const credentials = JSON.parse(config.firebase.serviceAccountKey);
    admin.initializeApp({ credential: admin.credential.cert(credentials) });
    firestore = admin.firestore();
  }
  return firestore;
}

function readLocalJson(localPath) {
  try {
    return JSON.parse(fs.readFileSync(localPath, "utf8"));
  } catch {
    return [];
  }
}

async function downloadRemoteJson(db, docId) {
  try {
    const snap = await db.collection("backups").doc(docId).get();
    if (!snap.exists) return [];
    return snap.data().records || [];
  } catch (err) {
    console.error(`[backup] failed to download ${docId}:`, err.message || err);
    return [];
  }
}

// Merges the local file with whatever's in Firestore, local wins on a
// matching ID (presumably more recent than a possibly-stale backup), keeps
// anything only found in one side. Writes the merged result back to disk.
// In the common post-redeploy case (local file empty), this is just "adopt
// the backup" — restoring prior data instead of starting from scratch.
export async function restoreAndMerge(localPath, remoteObjectName, idFn) {
  const db = getFirestore();
  if (!db) {
    console.log(`[backup] Firebase not configured, skipping restore for ${remoteObjectName}`);
    return;
  }

  const local = readLocalJson(localPath);
  const remote = await downloadRemoteJson(db, remoteObjectName);
  if (remote.length === 0 && local.length === 0) return;

  const merged = new Map(remote.map((record) => [idFn(record), record]));
  for (const record of local) merged.set(idFn(record), record);

  fs.writeFileSync(localPath, JSON.stringify([...merged.values()], null, 2));
  console.log(`[backup] restored ${remoteObjectName}: ${local.length} local + ${remote.length} remote -> ${merged.size} merged`);
}

// Fire-and-forget — not awaited by callers, so store.js/users.js keep their
// existing synchronous save functions unchanged. A failed backup logs but
// never affects the local write that already succeeded.
export function backupFile(localPath, remoteObjectName) {
  const db = getFirestore();
  if (!db) return;

  const records = readLocalJson(localPath);
  db.collection("backups").doc(remoteObjectName).set({
    records,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch((err) => console.error(`[backup] failed to upload ${remoteObjectName}:`, err.message || err));
}
