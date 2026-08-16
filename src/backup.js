import fs from "fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore as getFirestoreInstance, FieldValue } from "firebase-admin/firestore";
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
//
// Uses firebase-admin's modern modular API (firebase-admin/app,
// firebase-admin/firestore) rather than the old default-import style — the
// installed v14+ package doesn't expose admin.credential/.firestore() the
// old way, and using the old style threw "Cannot read properties of
// undefined (reading 'cert')" at startup.
let firestore = null;

// Tracks every in-flight Firestore write so a graceful shutdown (see
// flushPendingBackups below) can wait for them instead of the process
// exiting mid-write. Without this, backupFile/backupObjectFile being
// fire-and-forget meant a redeploy's SIGTERM could kill the process while a
// write was still in flight — the local write had already succeeded, but
// its Firestore copy never landed, and since Render wipes local disk on
// every redeploy, that row/entry was gone from BOTH places on next boot.
// Traced to real data loss: an application count that quietly shrank over
// a single evening of several redeploys.
const pendingBackups = new Set();

function trackBackup(promise) {
  pendingBackups.add(promise);
  const clear = () => pendingBackups.delete(promise);
  promise.then(clear, clear);
  return promise;
}

// Awaited from the SIGTERM/SIGINT handler in server.js before the process
// exits. Bounded by a timeout — Render's own grace period before SIGKILL
// isn't unlimited, and a hung Firestore call shouldn't hang shutdown
// forever when it would otherwise still lose the race either way.
export async function flushPendingBackups(timeoutMs = 8000) {
  if (pendingBackups.size === 0) return;
  console.log(`[backup] flushing ${pendingBackups.size} pending write(s) before shutdown...`);
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([Promise.allSettled([...pendingBackups]), timeout]);
  if (pendingBackups.size > 0) {
    console.error(`[backup] shutdown timeout hit with ${pendingBackups.size} write(s) still pending`);
  } else {
    console.log("[backup] all pending writes flushed");
  }
}

// Exported so other modules that need direct Firestore access for their own
// document shapes (userDirectory.js's activeUsers/inactiveUsers
// collections, which don't fit the generic "one document holds a whole
// JSON blob" pattern the rest of this file uses) can reuse the same lazily
// -initialized client instead of duplicating the credential/init logic.
export function getFirestore() {
  if (!config.firebase.serviceAccountKey) return null;
  if (!firestore) {
    const credentials = JSON.parse(config.firebase.serviceAccountKey);
    if (!getApps().length) {
      initializeApp({ credential: cert(credentials) });
    }
    firestore = getFirestoreInstance();
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
  if (remote.length === 0 && local.length === 0) {
    console.log(`[backup] nothing to restore for ${remoteObjectName} yet (both local and Firestore are empty)`);
    return;
  }

  const merged = new Map(remote.map((record) => [idFn(record), record]));
  for (const record of local) merged.set(idFn(record), record);

  fs.writeFileSync(localPath, JSON.stringify([...merged.values()], null, 2));
  console.log(`[backup] restored ${remoteObjectName}: ${local.length} local + ${remote.length} remote -> ${merged.size} merged`);
}

// Fire-and-forget from the CALLER's perspective — not awaited by
// store.js/users.js, so their synchronous save functions stay unchanged.
// The write itself is still tracked (see trackBackup) so a shutdown can
// wait for it even though the caller doesn't. A failed backup logs but
// never affects the local write that already succeeded.
export function backupFile(localPath, remoteObjectName) {
  const db = getFirestore();
  if (!db) return;

  const records = readLocalJson(localPath);
  trackBackup(
    db.collection("backups").doc(remoteObjectName).set({
      records,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch((err) => console.error(`[backup] failed to upload ${remoteObjectName}:`, err.message || err))
  );
}

// Object-keyed counterparts of restoreAndMerge/backupFile, for caches keyed
// by ID (Gmail message ID, normalized company name) rather than an
// array-of-records with an idFn — classificationCache.json and
// companyIdentityCache.json. Without this, every redeploy wiped these
// caches (local disk is ephemeral on Render), and the next scan re-burned
// real LLM/Serper quota re-classifying/re-resolving emails and companies
// that were already handled before the redeploy. Same local-wins-on-conflict
// merge semantics as restoreAndMerge, via object spread instead of a Map.
function readLocalObject(localPath) {
  try {
    return JSON.parse(fs.readFileSync(localPath, "utf8"));
  } catch {
    return {};
  }
}

async function downloadRemoteObject(db, docId) {
  try {
    const snap = await db.collection("backups").doc(docId).get();
    if (!snap.exists) return {};
    return snap.data().records || {};
  } catch (err) {
    console.error(`[backup] failed to download ${docId}:`, err.message || err);
    return {};
  }
}

export async function restoreAndMergeObject(localPath, remoteObjectName) {
  const db = getFirestore();
  if (!db) {
    console.log(`[backup] Firebase not configured, skipping restore for ${remoteObjectName}`);
    return;
  }

  const local = readLocalObject(localPath);
  const remote = await downloadRemoteObject(db, remoteObjectName);
  const localCount = Object.keys(local).length;
  const remoteCount = Object.keys(remote).length;
  if (remoteCount === 0 && localCount === 0) {
    console.log(`[backup] nothing to restore for ${remoteObjectName} yet (both local and Firestore are empty)`);
    return;
  }

  const merged = { ...remote, ...local };
  fs.writeFileSync(localPath, JSON.stringify(merged, null, 2));
  console.log(`[backup] restored ${remoteObjectName}: ${localCount} local + ${remoteCount} remote -> ${Object.keys(merged).length} merged`);
}

export function backupObjectFile(localPath, remoteObjectName) {
  const db = getFirestore();
  if (!db) return;

  const records = readLocalObject(localPath);
  trackBackup(
    db.collection("backups").doc(remoteObjectName).set({
      records,
      updatedAt: FieldValue.serverTimestamp(),
    }).catch((err) => console.error(`[backup] failed to upload ${remoteObjectName}:`, err.message || err))
  );
}
