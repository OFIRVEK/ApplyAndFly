import fs from "fs";
import { Storage } from "@google-cloud/storage";
import { config } from "./config.js";

// Reuses the existing Google Cloud project (already in place for OAuth,
// and for Gmail push notifications) rather than a new third-party service.
// Every function here degrades gracefully — logs and no-ops — when GCS
// isn't configured, so the app keeps working on local-disk-only storage
// exactly as before if this hasn't been set up.
let storageClient = null;

function getBucket() {
  if (!config.gcs.bucket || !config.gcs.serviceAccountKey) return null;
  if (!storageClient) {
    const credentials = JSON.parse(config.gcs.serviceAccountKey);
    storageClient = new Storage({ credentials, projectId: credentials.project_id });
  }
  return storageClient.bucket(config.gcs.bucket);
}

function readLocalJson(localPath) {
  try {
    return JSON.parse(fs.readFileSync(localPath, "utf8"));
  } catch {
    return [];
  }
}

async function downloadRemoteJson(bucket, remoteObjectName) {
  try {
    const [exists] = await bucket.file(remoteObjectName).exists();
    if (!exists) return [];
    const [contents] = await bucket.file(remoteObjectName).download();
    return JSON.parse(contents.toString("utf8"));
  } catch (err) {
    console.error(`[backup] failed to download ${remoteObjectName}:`, err.message || err);
    return [];
  }
}

// Merges the local file with whatever's in GCS, local wins on a matching
// ID (presumably more recent than a possibly-stale backup), keeps anything
// only found in one side. Writes the merged result back to disk. In the
// common post-redeploy case (local file empty), this is just "adopt the
// backup" — restoring prior data instead of starting from scratch.
export async function restoreAndMerge(localPath, remoteObjectName, idFn) {
  const bucket = getBucket();
  if (!bucket) {
    console.log(`[backup] GCS not configured, skipping restore for ${remoteObjectName}`);
    return;
  }

  const local = readLocalJson(localPath);
  const remote = await downloadRemoteJson(bucket, remoteObjectName);
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
  const bucket = getBucket();
  if (!bucket) return;

  bucket.file(remoteObjectName).save(fs.readFileSync(localPath, "utf8"), { contentType: "application/json" })
    .catch((err) => console.error(`[backup] failed to upload ${remoteObjectName}:`, err.message || err));
}
