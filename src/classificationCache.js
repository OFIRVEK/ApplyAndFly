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
  return cache[messageId] || null;
}

export function setCachedClassification(messageId, details) {
  const cache = loadCache();
  cache[messageId] = details;
  saveCache(cache);
}
