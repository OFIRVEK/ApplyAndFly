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
// cache miss once past this age, forcing a fresh Serper-backed resolution
// rather than trusting it indefinitely.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function getCachedCompanyIdentity(company) {
  const cache = loadCache();
  const entry = cache[normalizeKey(company)];
  if (!entry) return null;
  if (entry.resolvedAt && Date.now() - new Date(entry.resolvedAt).getTime() > TTL_MS) return null;
  return entry;
}

export function setCachedCompanyIdentity(company, identity) {
  const cache = loadCache();
  cache[normalizeKey(company)] = { ...identity, resolvedAt: new Date().toISOString() };
  saveCache(cache);
}
