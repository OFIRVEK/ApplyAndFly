import fs from "fs";
import path from "path";

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
}

export function getCachedCompanyIdentity(company) {
  const cache = loadCache();
  return cache[normalizeKey(company)] || null;
}

export function setCachedCompanyIdentity(company, identity) {
  const cache = loadCache();
  cache[normalizeKey(company)] = identity;
  saveCache(cache);
}
