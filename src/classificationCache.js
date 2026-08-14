import fs from "fs";
import path from "path";
import { backupObjectFile } from "./backup.js";

// Separate from `seen` on purpose: `seen` intentionally resets on every
// restart (so a restart re-scans the full window during testing), but that
// meant every restart also re-burned a Groq classification call on every
// email it had already classified before. This cache persists across
// restarts and is checked BEFORE calling Groq — same "clean re-scan"
// behavior, without paying for the same email twice.
const CACHE_FILE = path.resolve(process.cwd(), "classificationCache.json");

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  backupObjectFile(CACHE_FILE, "classificationCache.json");
}

export function getCachedClassification(messageId) {
  const cache = loadCache();
  const entry = cache[messageId] || null;
  // Entries written before the eventType schema (old shape:
  // isApplicationConfirmation/isRejection booleans) have no eventType, and
  // the routing in server.js would fall through every eventType check
  // straight into the confirmation path — turning an old cached REJECTION
  // into a fresh "application received" WhatsApp send. Treat them as cache
  // misses so they get re-classified under the current schema instead.
  return entry && entry.eventType ? entry : null;
}

export function setCachedClassification(messageId, details) {
  const cache = loadCache();
  cache[messageId] = details;
  saveCache(cache);
}
