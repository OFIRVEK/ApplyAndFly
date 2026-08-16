import fs from "fs";
import path from "path";
import { backupFile } from "./backup.js";

// Per-user registry: Gmail tokens, onboarding state, and dashboard access
// token, keyed by WhatsApp ID. Same flat-file pattern as store.js, backed up
// to Google Cloud Storage on every write and restored on startup — see
// backup.js — so a Render redeploy no longer forces every user to
// reconnect Gmail from scratch.
const USERS_FILE = path.resolve(process.cwd(), "users.json");

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  backupFile(USERS_FILE, "users.json");
}

export function getUser(waId) {
  return loadUsers().find((u) => u.waId === waId) || null;
}

// Resolves an inbound Gmail push notification (which only tells us the
// Gmail address, not the WhatsApp ID) back to the owning user record.
export function getUserByEmail(emailAddress) {
  if (!emailAddress) return null;
  return loadUsers().find((u) => u.emailAddress === emailAddress) || null;
}

// Creates the record on first call, merges fields on subsequent calls —
// used both for onboarding (tokens, folder, dashboardToken) and for the
// OAuth client's silent-refresh callback (tokens only).
export function upsertUser(waId, fields) {
  const users = loadUsers();
  const existing = users.find((u) => u.waId === waId);

  if (existing) {
    Object.assign(existing, fields, { lastUpdated: new Date().toISOString() });
    saveUsers(users);
    return existing;
  }

  const created = {
    waId,
    tokens: null,
    folder: null,
    dashboardToken: null,
    emailAddress: null,
    historyId: null,
    watchExpiration: null,
    paused: false,
    // "active" | "inactive" — set to "inactive" by the unsubscribe flow.
    // Doesn't gate onboarding: a null `tokens` field already does that (see
    // handleIncomingWhatsAppMessage's rehydration check), this exists so
    // the dashboard/admin-facing code has an explicit, readable status
    // rather than inferring it from tokens being null.
    status: "active",
    // Every prior dashboardToken this waId has ever had, each with when it
    // stopped being the live one — so an old dashboard link keeps resolving
    // (read-only, frozen at whatever it held) forever, even after
    // unsubscribing and resubscribing mints a fresh current token.
    previousDashboardTokens: [],
    onboardedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    ...fields,
  };
  users.push(created);
  saveUsers(users);
  return created;
}

export function getAllUsers() {
  return loadUsers();
}

// Resolves a dashboard token whether it's the user's CURRENT token or one
// of their historical (frozen) ones — the whole point of keeping
// previousDashboardTokens is that old links must keep working forever, not
// 404 once a newer one is minted. Returns the user plus an
// isCurrentDashboard flag so callers (server.js's dashboard routes) know
// whether to allow mutation (current) or serve read-only (historical).
export function getUserByDashboardToken(token) {
  if (!token) return null;
  const user = loadUsers().find((u) =>
    u.dashboardToken === token || (u.previousDashboardTokens || []).some((entry) => entry.token === token)
  );
  if (!user) return null;
  return { ...user, isCurrentDashboard: user.dashboardToken === token };
}
