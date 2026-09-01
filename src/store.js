import fs from "fs";
import path from "path";
import { backupFile } from "./backup.js";

// Deliberately simple: one flat JSON file, no real database. Every row is
// tagged with the WhatsApp ID of the user it belongs to — every lookup and
// mutation below filters by that owner, so one user's dashboard action can
// never see or touch another user's rows even if they guess a company name.
const STORE_FILE = path.resolve(process.cwd(), "applications.json");

function loadApplications() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveApplications(apps) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(apps, null, 2));
  backupFile(STORE_FILE, "applications.json");
}

function normalize(company = "") {
  return company.trim().toLowerCase();
}

function resolveDate(candidate) {
  const parsed = candidate ? new Date(candidate) : null;
  return parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

export function findApplication(waId, company, position, sourceMessageId, appliedDate) {
  const apps = loadApplications().filter((a) => a.waId === waId);
  if (sourceMessageId) {
    const exactMessage = apps.find((a) => a.sourceMessageId === sourceMessageId);
    if (exactMessage) return exactMessage;
  }

  // Old rows created before sourceMessageId existed can still be matched by
  // company + position + application day. New rows are always deduplicated by
  // Gmail message ID, allowing separate applications to the same company to
  // coexist while a restart cannot re-add legacy rows from the same email.
  const companyKey = normalize(company);
  const positionKey = normalize(position);
  const candidateDate = appliedDate ? new Date(appliedDate).toDateString() : null;
  return apps.find((a) =>
    !a.sourceMessageId &&
    normalize(a.company) === companyKey &&
    normalize(a.position) === positionKey &&
    (!candidateDate || new Date(a.appliedDate).toDateString() === candidateDate)
  ) || null;
}

// Adds a new tracked application at "Applied" status. Gmail message IDs make
// restart scans idempotent without treating one company as a single row:
// separate roles/applications at the same company are intentionally retained.
export function addApplication({ waId, company, position, briefExplanation, appliedDate, sourceMessageId, threadId, research, dashboardGeneration, referredBy }) {
  const apps = loadApplications();
  if (sourceMessageId && apps.some((a) => a.waId === waId && a.sourceMessageId === sourceMessageId)) return false;

  apps.push({
    waId,
    company,
    position,
    briefExplanation,
    status: "Applied",
    appliedDate: resolveDate(appliedDate),
    lastUpdated: new Date().toISOString(),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(research ? { research } : {}),
    ...(referredBy ? { referredBy } : {}),
    // Which dashboardToken was "current" when this row was created — lets a
    // frozen (post-unsubscribe) dashboard show exactly what belonged to
    // that subscription, while a fresh resubscribe's dashboard starts
    // empty instead of inheriting old history. Omitted (undefined) if the
    // caller doesn't pass one — see getApplicationsForGeneration for how
    // untagged legacy rows (created before this existed) are handled.
    ...(dashboardGeneration ? { dashboardGeneration } : {}),
  });
  saveApplications(apps);
  return true;
}

// A rejection/interview/offer email is very often a reply within the SAME
// Gmail thread as the original confirmation — that's a structural signal
// from the email system itself, not a guessed text match, so it's checked
// before any company/position heuristic. Only ever succeeds for a thread
// that was actually recorded (i.e. every row created from here on), so it
// naturally falls through to the older matching logic for anything tracked
// before this existed, or for ATS platforms that start a fresh thread per
// stage.
export function updateApplicationStatusByThread(waId, threadId, status) {
  if (!threadId) return false;
  const apps = loadApplications();
  const app = apps.find((a) => a.waId === waId && a.threadId === threadId);
  if (!app) return false;

  app.status = status;
  app.lastUpdated = new Date().toISOString();
  saveApplications(apps);
  return true;
}

// Moves an already-tracked application to a new status (In Progress,
// Rejected, Hired). Does nothing if the company isn't tracked yet — we only
// update applications that started with a real confirmation.
export function updateApplicationStatus(waId, company, status, position, eventDate) {
  const apps = loadApplications();
  const key = normalize(company);
  const positionKey = normalize(position);
  const matching = apps.filter((a) => a.waId === waId && normalize(a.company) === key);
  // Each application is its own standalone thing — reapplying to the same
  // company for a different (even similarly-worded) role is intentionally
  // never merged into an earlier one, so this stays an exact position match.
  const samePosition = positionKey && !/not specified/i.test(position)
    ? matching.filter((a) => normalize(a.position) === positionKey)
    : matching;
  const eventTime = eventDate ? new Date(eventDate).getTime() : NaN;
  const beforeEvent = !isNaN(eventTime)
    ? samePosition.filter((a) => new Date(a.appliedDate).getTime() <= eventTime)
    : samePosition;
  const app = (beforeEvent.length ? beforeEvent : samePosition)
    .sort((a, b) => new Date(b.appliedDate) - new Date(a.appliedDate))[0];
  if (!app) return false;

  app.status = status;
  app.lastUpdated = new Date().toISOString();
  saveApplications(apps);
  return true;
}

export function updateApplicationStatusByRow({ waId, company, position, appliedDate, sourceMessageId, status }) {
  const apps = loadApplications();
  const key = normalize(company);
  const targetDate = appliedDate ? new Date(appliedDate).getTime() : NaN;
  const app = sourceMessageId
    ? apps.find((entry) => entry.waId === waId && entry.sourceMessageId === sourceMessageId)
    : apps.find((entry) =>
      entry.waId === waId &&
      normalize(entry.company) === key &&
      normalize(entry.position) === normalize(position) &&
      new Date(entry.appliedDate).getTime() === targetDate
    );
  if (!app) return false;

  app.status = status;
  app.lastUpdated = new Date().toISOString();
  saveApplications(apps);
  return true;
}

// For when a rejection/interview/offer email arrives for a company that was
// never tracked in the first place (e.g. the original confirmation scrolled
// out of the scan window before the dashboard existed, or was missed for
// any other reason). Rather than silently dropping the signal, this backs
// the row in directly at the target status instead of "Applied" — losing
// the true apply date, but at least surfacing it on the dashboard.
export function upsertApplicationStatus({ waId, company, position, briefExplanation, status, fallbackDate, sourceMessageId, threadId, research, dashboardGeneration, referredBy }) {
  const apps = loadApplications();
  const key = normalize(company);
  const positionKey = normalize(position);
  const existing = (sourceMessageId && apps.find((a) => a.waId === waId && a.sourceMessageId === sourceMessageId))
    || apps.find((a) => a.waId === waId && normalize(a.company) === key && normalize(a.position) === positionKey);

  if (existing) {
    existing.status = status;
    existing.lastUpdated = new Date().toISOString();
    saveApplications(apps);
    return;
  }

  apps.push({
    waId,
    company,
    position,
    briefExplanation,
    status,
    appliedDate: resolveDate(fallbackDate),
    lastUpdated: new Date().toISOString(),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(research ? { research } : {}),
    ...(dashboardGeneration ? { dashboardGeneration } : {}),
    ...(referredBy ? { referredBy } : {}),
  });
  saveApplications(apps);
}

// Updates just the description on an already-tracked entry (e.g. after a
// re-enrichment finds better info than what it started with).
export function updateApplicationDescription(waId, company, briefExplanation) {
  const apps = loadApplications();
  const key = normalize(company);
  const matching = apps.filter((a) => a.waId === waId && normalize(a.company) === key);
  if (matching.length === 0) return false;

  for (const app of matching) {
    app.briefExplanation = briefExplanation;
    app.lastUpdated = new Date().toISOString();
  }
  saveApplications(apps);
  return true;
}

// Mirrors the "verified" bar used before a fresh snapshot is even attempted
// (server.js's isVerifiedResearch/isApplicationAlreadyVerified) — kept here
// too, at the point of the actual write, so a row that already has good
// data can never be regressed to "Not verified" no matter which caller (or
// future caller) reaches this function.
function isAlreadyVerified(app) {
  return (app.research?.confidence || 0) >= 75
    && Array.isArray(app.research?.sources)
    && app.research.sources.some((source) => !/linkedin\.com/i.test(source))
    && Boolean(app.briefExplanation)
    && !/could not be confidently verified|not verified/i.test(app.briefExplanation);
}

// Replaces a description only after the evidence-first pipeline has verified
// the company/domain. All applications at that company normally share the
// same company overview and are updated together while retaining their own
// roles and application dates — except any row that's already individually
// verified, which is left untouched rather than being dragged down by a
// fresh lookup that happens to do worse (e.g. a search-quota outage).
export function updateApplicationResearch(waId, company, snapshot) {
  const apps = loadApplications();
  const key = normalize(company);
  const matching = apps.filter((a) => a.waId === waId && normalize(a.company) === key && !isAlreadyVerified(a));
  if (matching.length === 0) return 0;

  const research = {
    sources: snapshot.sources || [],
    confidence: snapshot.confidence || 0,
    refreshedAt: new Date().toISOString(),
  };
  for (const app of matching) {
    app.briefExplanation = snapshot.whatTheyDo;
    app.research = research;
    app.lastUpdated = research.refreshedAt;
  }
  saveApplications(apps);
  return matching.length;
}

// A company's identity/description never depends on which position was
// applied for — so if any application at a company already has verified
// data, every other application at that SAME company can just reuse it
// directly, no fresh search needed. Covers cases like a later email (e.g.
// an interview notice) landing on a differently-worded position, creating
// a fresh, initially-unverified row for a company that's already known.
// Returns the number of rows filled in.
export function fillMissingResearchFromSiblings(waId) {
  const apps = loadApplications();
  const byCompany = new Map();
  for (const app of apps) {
    if (app.waId !== waId) continue;
    const key = normalize(app.company);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(app);
  }

  let filled = 0;
  for (const group of byCompany.values()) {
    if (group.length < 2) continue;
    const source = group.find(isAlreadyVerified);
    if (!source) continue;
    for (const app of group) {
      if (app === source || isAlreadyVerified(app)) continue;
      app.briefExplanation = source.briefExplanation;
      app.research = { ...source.research, refreshedAt: new Date().toISOString() };
      app.lastUpdated = app.research.refreshedAt;
      filled += 1;
    }
  }

  if (filled > 0) saveApplications(apps);
  return filled;
}

export function removeApplicationsByCompany(waId, company) {
  const apps = loadApplications();
  const key = normalize(company);
  const remaining = apps.filter((app) => !(app.waId === waId && normalize(app.company) === key));
  const removed = apps.length - remaining.length;
  if (removed > 0) saveApplications(remaining);
  return removed;
}

export function getAllApplications(waId) {
  return loadApplications().filter((a) => a.waId === waId);
}

// Scopes a dashboard's view to one subscription "generation" — see
// dashboardGeneration in addApplication/upsertApplicationStatus above.
// isCurrent=true (the live, current dashboard) also includes untagged rows
// (created before this feature existed, or by any future caller that
// doesn't pass a generation) so nothing already on an active dashboard
// silently disappears. isCurrent=false (a historical/frozen link reached
// via a previousDashboardTokens entry) is strict — only rows explicitly
// tagged with that exact generation, so a frozen dashboard shows precisely
// what belonged to it and never picks up untagged/ambiguous rows.
export function getApplicationsForGeneration(waId, generationToken, isCurrent) {
  const apps = loadApplications().filter((a) => a.waId === waId);
  if (isCurrent) {
    return apps.filter((a) => !a.dashboardGeneration || a.dashboardGeneration === generationToken);
  }
  return apps.filter((a) => a.dashboardGeneration === generationToken);
}

// One-time migration, run once at boot (see server.js) — tags every
// pre-existing untagged row with the generation token that's current RIGHT
// NOW, closing a real gap: without this, a resubscribe's brand-new
// dashboard would inherit ALL untagged legacy rows (since untagged reads
// as "belongs to current" — see getApplicationsForGeneration above), and
// the frozen old dashboard would show NONE of them (since they don't match
// the archived token either) — exactly backwards from "old dashboard keeps
// its history, new one starts empty." Idempotent: once a row is tagged it
// stays tagged, so repeat boots after the first are a no-op per user.
export function tagUntaggedApplications(waId, generationToken) {
  const apps = loadApplications();
  let tagged = 0;
  for (const app of apps) {
    if (app.waId === waId && !app.dashboardGeneration) {
      app.dashboardGeneration = generationToken;
      tagged += 1;
    }
  }
  if (tagged > 0) saveApplications(apps);
  return tagged;
}
