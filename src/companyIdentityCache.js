import fs from "fs";
import path from "path";
import { backupObjectFile } from "./backup.js";

// Persists resolved company -> domain identity across restarts and across
// repeat applications to the same company, so a company only ever costs
// Serper search quota once. Keyed by a normalized company name, mirroring
// classificationCache.js's persistence pattern.
const CACHE_FILE = path.resolve(process.cwd(), "companyIdentityCache.json");

function normalizeKey(company = "") {
  return company.trim().toLowerCase();
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  backupObjectFile(CACHE_FILE, "companyIdentityCache.json");
}

// A verified domain doesn't stay trustworthy forever — a company can change
// domains, get acquired, or a stale entry could just be wrong. Treated as a
// cache miss once past this age, forcing a fresh search-backed resolution
// rather than trusting it indefinitely.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

// An UNVERIFIED miss is cached too, but for far less time. Without this, a
// company whose site never clears the verification bar (small company, bot
// -blocked site, etc.) burns a full fresh round of search-API quota on
// EVERY email about it — confirmation, then interview, then rejection can
// each independently re-run the same failed search. That repeat-cost is the
// single biggest source of wasted search quota in practice, well beyond
// whatever the underlying provider's free-tier size is. Short enough that
// it still retries periodically (the site could come back online, or the
// search index could catch up), unlike a verified identity's 30 days.
const UNVERIFIED_TTL_MS = 24 * 60 * 60 * 1000;

export function getCachedCompanyIdentity(company) {
  const cache = loadCache();
  const entry = cache[normalizeKey(company)];
  if (!entry) return null;
  const ttl = entry.verified ? TTL_MS : UNVERIFIED_TTL_MS;
  if (entry.resolvedAt && Date.now() - new Date(entry.resolvedAt).getTime() > ttl) return null;
  return entry;
}

export function setCachedCompanyIdentity(company, identity) {
  const cache = loadCache();
  cache[normalizeKey(company)] = { ...identity, resolvedAt: new Date().toISOString() };
  saveCache(cache);
}
