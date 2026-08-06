import fs from "fs";
import path from "path";

// Deliberately simple: one flat JSON file, no real database. Matches for the
// dashboard feature — a single-user personal tool doesn't need more than this.
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
}

function normalize(company = "") {
  return company.trim().toLowerCase();
}

function resolveDate(candidate) {
  const parsed = candidate ? new Date(candidate) : null;
  return parsed && !isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

export function findApplication(company, position, sourceMessageId, appliedDate) {
  const apps = loadApplications();
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
export function addApplication({ company, position, briefExplanation, appliedDate, sourceMessageId, research }) {
  const apps = loadApplications();
  if (sourceMessageId && apps.some((a) => a.sourceMessageId === sourceMessageId)) return false;

  apps.push({
    company,
    position,
    briefExplanation,
    status: "Applied",
    appliedDate: resolveDate(appliedDate),
    lastUpdated: new Date().toISOString(),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(research ? { research } : {}),
  });
  saveApplications(apps);
  return true;
}

// Moves an already-tracked application to a new status (In Progress,
// Rejected, Hired). Does nothing if the company isn't tracked yet — we only
// update applications that started with a real confirmation.
export function updateApplicationStatus(company, status, position, eventDate) {
  const apps = loadApplications();
  const key = normalize(company);
  const positionKey = normalize(position);
  const matching = apps.filter((a) => normalize(a.company) === key);
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

export function updateApplicationStatusByRow({ company, position, appliedDate, sourceMessageId, status }) {
  const apps = loadApplications();
  const key = normalize(company);
  const targetDate = appliedDate ? new Date(appliedDate).getTime() : NaN;
  const app = sourceMessageId
    ? apps.find((entry) => entry.sourceMessageId === sourceMessageId)
    : apps.find((entry) =>
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
export function upsertApplicationStatus({ company, position, briefExplanation, status, fallbackDate, sourceMessageId, research }) {
  const apps = loadApplications();
  const key = normalize(company);
  const positionKey = normalize(position);
  const existing = (sourceMessageId && apps.find((a) => a.sourceMessageId === sourceMessageId))
    || apps.find((a) => normalize(a.company) === key && normalize(a.position) === positionKey);

  if (existing) {
    existing.status = status;
    existing.lastUpdated = new Date().toISOString();
    saveApplications(apps);
    return;
  }

  apps.push({
    company,
    position,
    briefExplanation,
    status,
    appliedDate: resolveDate(fallbackDate),
    lastUpdated: new Date().toISOString(),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(research ? { research } : {}),
  });
  saveApplications(apps);
}

// Updates just the description on an already-tracked entry (e.g. after a
// re-enrichment finds better info than what it started with).
export function updateApplicationDescription(company, briefExplanation) {
  const apps = loadApplications();
  const key = normalize(company);
  const matching = apps.filter((a) => normalize(a.company) === key);
  if (matching.length === 0) return false;

  for (const app of matching) {
    app.briefExplanation = briefExplanation;
    app.lastUpdated = new Date().toISOString();
  }
  saveApplications(apps);
  return true;
}

// Replaces a description only after the evidence-first pipeline has verified
// the company/domain. All applications at that company share the same company
// overview, so they are updated together while retaining their own roles and
// application dates.
export function updateApplicationResearch(company, snapshot) {
  const apps = loadApplications();
  const key = normalize(company);
  const matching = apps.filter((a) => normalize(a.company) === key);
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

export function removeApplicationsByCompany(company) {
  const apps = loadApplications();
  const key = normalize(company);
  const remaining = apps.filter((app) => normalize(app.company) !== key);
  const removed = apps.length - remaining.length;
  if (removed > 0) saveApplications(remaining);
  return removed;
}

export function getAllApplications() {
  return loadApplications();
}
