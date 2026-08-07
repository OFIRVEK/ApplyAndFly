import express from "express";
import path from "path";
import crypto from "crypto";
import { config } from "./config.js";
import { oauth2Client, getAuthUrl } from "./auth.js";
import { getGmailClient, listEmails, listEmailsByFolder, getEmail, decodeEmail, decodeEmailHtml } from "./gmail.js";
import { isJobEmail, hasStrongConfirmationPhrase, looksLikeRejection, looksLikeInterviewStage, looksLikeOffer, looksNonEnglish, looksJobRelatedNonEnglish, looksPromotional, looksNonJobTransactional, looksLikePayment, looksLikeJobSuggestion, looksLikeAccountNotice, looksLikeIsraeliEmploymentServiceNotice } from "./processor.js";
import { sendWhatsApp, sendWhatsAppTemplate } from "./whatsapp.js";
import { classifyEmail, extractPositionFromSubject, formatConfirmationMessage } from "./enrich.js";
import { researchCompanyFromEvidence } from "./companyEvidence.js";
import { addApplication, findApplication, updateApplicationStatus, updateApplicationStatusByRow, upsertApplicationStatus, updateApplicationDescription, updateApplicationResearch, removeApplicationsByCompany, getAllApplications } from "./store.js";
import { getCachedClassification, setCachedClassification } from "./classificationCache.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || config.port || 3000;

/**
 * DASHBOARD — separate Express app, its own port, so it's independent of
 * the main app (auth/webhook) — matches the requirement that the dashboard
 * (2000) and the bot (3000) are two distinct listeners, not one shared one.
 */
const dashboardApp = express();
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 2000;

dashboardApp.use(express.json());
dashboardApp.use(express.static(path.resolve(process.cwd(), "public")));

dashboardApp.get("/dashboard", (req, res) => {
  res.sendFile(path.resolve(process.cwd(), "public", "dashboard.html"));
});

dashboardApp.get("/api/applications", (req, res) => {
  res.json(getAllApplications());
});

dashboardApp.patch("/api/applications/status", (req, res) => {
  const { company, position, appliedDate, sourceMessageId, status } = req.body || {};
  const validStatuses = new Set(["Applied", "In Progress", "Rejected", "Hired"]);
  if (!company || !validStatuses.has(status)) {
    return res.status(400).json({ error: "A company and a valid status are required" });
  }

  const updated = updateApplicationStatusByRow({ company, position, appliedDate, sourceMessageId, status });
  if (!updated) return res.status(404).json({ error: "Application not found" });
  res.json({ updated: true });
});

// The dashboard also lives under the main app. Locally it remains available
// on :2000 for convenience; on Render the single public service exposes the
// same dashboard at https://your-domain/dashboard.
app.use(dashboardApp);

dashboardApp.listen(DASHBOARD_PORT, () => {
  console.log(`Dashboard running on http://localhost:${DASHBOARD_PORT}/dashboard`);
});

let userAuth = null;
let researchRefreshJob = {
  running: false,
  startedAt: null,
  finishedAt: null,
  totalCompanies: 0,
  processedCompanies: 0,
  updatedRows: 0,
  skippedCompanies: 0,
  errors: [],
};
// Set once WhatsApp-first onboarding completes; overrides the hardcoded
// WHATSAPP_TO_NUMBER fallback so replies go to whoever actually onboarded.
let activeRecipient;
// In-memory only: resets on every restart, so a restart re-scans the full
// maxResults window from scratch.
let seen = new Set();
let pollInProgress = false;

// CSRF protection for the OAuth flow (Google's own security checkup flags
// omitting this): each authorization attempt gets a random, unguessable
// token that's issued here and re-checked in the callback, so the callback
// only ever completes an auth flow this server actually started — not one
// forged by an attacker. Also carries the WhatsApp ID through for the
// onboarding flow, replacing the old approach of putting the waId directly
// in `state` (predictable, and not validated against anything server-side).
const pendingOAuthStates = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function createOAuthState(waId = null) {
  const now = Date.now();
  for (const [token, entry] of pendingOAuthStates) {
    if (now - entry.createdAt > OAUTH_STATE_TTL_MS) pendingOAuthStates.delete(token);
  }
  const token = crypto.randomBytes(24).toString("hex");
  pendingOAuthStates.set(token, { waId, createdAt: now });
  return token;
}

// One-time use: consuming a state token removes it, so a captured/replayed
// callback URL can't be completed a second time.
function consumeOAuthState(token) {
  if (!token || !pendingOAuthStates.has(token)) return null;
  const entry = pendingOAuthStates.get(token);
  pendingOAuthStates.delete(token);
  if (Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) return null;
  return entry;
}

// One entry per WhatsApp user who has started onboarding. Keyed by their
// WhatsApp ID (phone number). Single-user in practice today, but keyed this
// way so it's ready for more than one WhatsApp identity later.
const sessions = new Map();

// WhatsApp only allows free-form text messages within 24h of the user's
// last inbound message — a background poll can easily find a new
// confirmation outside that window, and the send API returns "success"
// while silently never delivering. Track the last inbound message per
// WhatsApp ID, and queue outgoing messages instead of sending them when the
// window is closed; the queue flushes the moment they message us again.
const lastInboundAt = new Map();
const pendingMessages = new Map();
const WINDOW_MS = 24 * 60 * 60 * 1000;

function isWindowOpen(waId) {
  const last = lastInboundAt.get(waId);
  return last !== undefined && Date.now() - last < WINDOW_MS;
}

function queuePendingMessage(waId, message) {
  const existing = pendingMessages.get(waId) || [];
  existing.push(message);
  pendingMessages.set(waId, existing);
}

async function flushPendingMessages(waId) {
  const queued = pendingMessages.get(waId);
  if (!queued || queued.length === 0) return;
  pendingMessages.delete(waId);
  for (const message of queued) {
    await sendWhatsApp(message, waId);
  }
}

// Once the 24h template is approved (see earlier plan), it'll explicitly
// ask "want to keep receiving these updates?" — so a reply only counts as
// consent to flush the queue when it's actually affirmative, not just any
// message. Prevents dumping a pile of old updates on top of an unrelated
// reply.
const AFFIRMATIVE_REPLIES = ["yes", "y", "sure", "ok", "okay", "continue", "yep", "yeah", "כן"];

function isAffirmative(text = "") {
  return AFFIRMATIVE_REPLIES.includes(text.trim().toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prefixes log lines with the current date/time — helps correlate which
// poll-cycle lines belong together across the 8s throttle + LLM call delays.
function ts() {
  return new Date().toLocaleString("en-GB", { hour12: false });
}

// 🔥 ADD THIS (fix race / duplicate callback issues)
let authInProgress = false;

/**
 * STEP 1: start OAuth
 */
app.get("/auth/google", (req, res) => {
  const url = getAuthUrl(createOAuthState());
  console.log("Redirecting to Google OAuth:", url);
  res.redirect(url);
});

/**
 * STEP 2: OAuth callback
 */
app.get("/auth/google/callback", async (req, res) => {
  try {
    if (authInProgress) {
      return res.send("Auth already processing...");
    }

    authInProgress = true;

    const code = req.query.code;

    // 🔥 THIS is your "Missing OAuth code" safeguard
    if (!code) {
      authInProgress = false;
      return res.status(400).send(
        "Missing OAuth code. You must start from /auth/google"
      );
    }

    const stateEntry = consumeOAuthState(req.query.state);
    if (!stateEntry) {
      authInProgress = false;
      return res.status(400).send(
        "Invalid or expired auth request. You must start from /auth/google"
      );
    }
    const waId = stateEntry.waId; // present when this OAuth flow started from WhatsApp

    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);
    userAuth = oauth2Client;

    authInProgress = false;

    console.log("✅ OAuth success. Tokens received.");

    if (waId) {
      activeRecipient = waId;
      sessions.set(waId, { state: "awaiting_folder_answer" });
      await sendWhatsApp(
        `✅ Google connected!\n\nDo you have a folder where you moved your recent job application emails? If yes, reply with its name. If not, reply "Continue".`,
        waId
      );
      return res.send("✅ Auth successful — check WhatsApp to finish setup.");
    }

    res.send("✅ Auth successful. Bot is now running.");
  } catch (err) {
    authInProgress = false;

    console.error("OAuth error:", err?.response?.data || err);

    res.status(500).send("Authentication failed");
  }
});

/**
 * WHATSAPP WEBHOOK — receives inbound messages (Meta calls this)
 */
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook/whatsapp", (req, res) => {
  res.sendStatus(200); // ack immediately, Meta expects a fast response

  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || message.type !== "text") return;

  const waId = message.from;
  const text = message.text?.body?.trim() || "";

  console.log(`[whatsapp] inbound from ${waId}: "${text}"`);

  handleIncomingWhatsAppMessage(waId, text).catch((err) =>
    console.error("Webhook handling error:", err)
  );
});

/**
 * TEMPORARY DEBUG ROUTES — for manually backfilling a handful of dashboard
 * entries using the live, already-authenticated Gmail session. Remove once
 * the backfill is done; not meant to stay in the app long-term.
 */
app.get("/debug/search", async (req, res) => {
  if (!userAuth) return res.status(401).send("Not authenticated");
  try {
    const gmail = getGmailClient(userAuth);
    const q = req.query.company;
    const result = await gmail.users.messages.list({ userId: "me", q: `"${q}"`, maxResults: 5 });
    const matches = [];
    for (const m of result.data.messages || []) {
      const full = await getEmail(gmail, m.id);
      matches.push({
        id: m.id,
        subject: full.payload?.headers?.find((h) => h.name === "Subject")?.value || "",
        from: full.payload?.headers?.find((h) => h.name === "From")?.value || "",
        date: full.payload?.headers?.find((h) => h.name === "Date")?.value || "",
      });
    }
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message || String(err) });
  }
});

app.get("/debug/backfill", async (req, res) => {
  if (!userAuth) return res.status(401).send("Not authenticated");
  try {
    const gmail = getGmailClient(userAuth);
    const { messageId, company, position } = req.query;
    const full = await getEmail(gmail, messageId);
    const body = decodeEmail(full);
    const html = decodeEmailHtml(full);
    const fromHeader = full.payload?.headers?.find((h) => h.name === "From")?.value || "";

    const snapshot = await researchCompanyFromEvidence({ company, position, fromHeader, body, html });
    const updated = updateApplicationDescription(company, snapshot.whatTheyDo);

    res.json({ fromHeader, snapshot, updated });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message || String(err) });
  }
});

function normalizeForMatch(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function historicalConfirmationScore({ company, position, appliedDate }, subject, body, dateHeader) {
  const text = `${subject}\n${body}`;
  const normalizedText = normalizeForMatch(text);
  let score = normalizedText.includes(normalizeForMatch(company)) ? 30 : 0;
  if (/thank you for applying|thanks for applying|we(?:'ve| have)? received your application|application (?:has been )?received|application (?:has been )?submitted/i.test(text)) {
    score += 50;
  }

  const positionWords = (position || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  if (positionWords.length > 0 && positionWords.some((word) => normalizedText.includes(word))) score += 20;

  const expected = new Date(appliedDate);
  const actual = new Date(dateHeader);
  if (!isNaN(expected) && !isNaN(actual) && Math.abs(expected - actual) < 7 * 24 * 60 * 60 * 1000) score += 10;
  return score;
}

async function findHistoricalConfirmation(gmail, application) {
  if (application.sourceMessageId) {
    try {
      return await getEmail(gmail, application.sourceMessageId);
    } catch {
      // The message may have been deleted; fall through to a careful search.
    }
  }

  const result = await gmail.users.messages.list({
    userId: "me",
    q: `"${application.company}"`,
    maxResults: 10,
  });

  let best = null;
  for (const message of result.data.messages || []) {
    const full = await getEmail(gmail, message.id);
    const subject = full.payload?.headers?.find((header) => header.name === "Subject")?.value || "";
    const date = full.payload?.headers?.find((header) => header.name === "Date")?.value || "";
    const score = historicalConfirmationScore(application, subject, decodeEmail(full), date);
    if (!best || score > best.score) best = { full, score };
  }

  // Require an explicit confirmation signal. A company mention in a newsletter,
  // job alert, or unrelated conversation is never enough to refresh a row.
  return best?.score >= 80 ? best.full : null;
}

function isVerifiedResearch(snapshot) {
  return snapshot.confidence >= 75
    && Array.isArray(snapshot.sources)
    && snapshot.sources.some((source) => !/linkedin\.com/i.test(source))
    && snapshot.whatTheyDo
    && !/could not be confidently verified|not verified/i.test(snapshot.whatTheyDo);
}

async function refreshDashboardResearch(companyFilter = null) {
  const applications = getAllApplications();
  const groups = new Map();
  for (const application of applications) {
    if (companyFilter && application.company.toLowerCase() !== companyFilter.toLowerCase()) continue;
    const key = application.company.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(application);
  }

  researchRefreshJob = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalCompanies: groups.size,
    processedCompanies: 0,
    updatedRows: 0,
    skippedCompanies: 0,
    errors: [],
  };

  try {
    const gmail = getGmailClient(userAuth);
    for (const applicationsAtCompany of groups.values()) {
      const application = applicationsAtCompany[0];
      try {
        const email = await findHistoricalConfirmation(gmail, application);
        if (!email) {
          researchRefreshJob.skippedCompanies += 1;
          continue;
        }

        const fromHeader = email.payload?.headers?.find((header) => header.name === "From")?.value || "";
        const snapshot = await researchCompanyFromEvidence({
          company: application.company,
          position: application.position,
          fromHeader,
          body: decodeEmail(email),
          html: decodeEmailHtml(email),
        });

        if (!isVerifiedResearch(snapshot)) {
          researchRefreshJob.skippedCompanies += 1;
          continue;
        }

        const oldDescription = applicationsAtCompany[0].briefExplanation?.trim() || "";
        if (oldDescription !== snapshot.whatTheyDo.trim()) {
          researchRefreshJob.updatedRows += updateApplicationResearch(application.company, snapshot);
        }
      } catch (err) {
        researchRefreshJob.errors.push({
          company: application.company,
          message: err.response?.data?.error?.message || err.message || "Research failed",
        });
      } finally {
        researchRefreshJob.processedCompanies += 1;
      }
    }
  } finally {
    researchRefreshJob.running = false;
    researchRefreshJob.finishedAt = new Date().toISOString();
  }
}

// Runs entirely in the background and never sends WhatsApp. It refreshes a
// stored description only when the original confirmation email is found and
// the new research independently verifies the company/domain.
dashboardApp.post("/api/applications/refresh", (req, res) => {
  if (!userAuth) return res.status(401).json({ error: "Reconnect Gmail first" });
  if (researchRefreshJob.running) return res.status(409).json(researchRefreshJob);

  const company = typeof req.query.company === "string" ? req.query.company.trim() : null;
  refreshDashboardResearch(company || null).catch((err) => {
    console.error("Dashboard research refresh failed:", err);
  });
  res.status(202).json({ started: true });
});

dashboardApp.get("/api/applications/refresh-status", (req, res) => {
  res.json(researchRefreshJob);
});

/**
 * ONBOARDING CONVERSATION
 */
async function handleIncomingWhatsAppMessage(waId, text) {
  // Any inbound message reopens the 24h window, but a pending queue only
  // gets flushed on an affirmative reply — not just any message — since the
  // template that prompts them will explicitly ask if they still want
  // these updates.
  lastInboundAt.set(waId, Date.now());
  if (isAffirmative(text)) {
    await flushPendingMessages(waId);
  } else if ((pendingMessages.get(waId) || []).length > 0) {
    console.log(`[whatsapp] ${waId} has pending messages but reply wasn't affirmative — not flushing`);
  }

  const session = sessions.get(waId);

  if (!session) {
    sessions.set(waId, { state: "awaiting_oauth" });
    const authUrl = getAuthUrl(createOAuthState(waId));
    await sendWhatsApp(
      `👋 Hey, thanks for choosing ApplyAndFly as your applications manager!\n\nFirst, sign in with Google so I can read your Gmail:\n${authUrl}`,
      waId
    );
    return;
  }

  if (session.state === "awaiting_folder_answer") {
    const folder = text.toLowerCase() === "continue" ? null : text;
    activeRecipient = waId;

    if (folder) {
      await sendWhatsApp(`Got it — scanning "${folder}" for existing applications first...`, waId);
      await scanFolderOnce(folder);
    }

    sessions.set(waId, { state: "onboarded", folder });
    await sendWhatsApp(
      `✅ All set! I'll keep watching your Inbox for new application confirmations.`,
      waId
    );
  }
}

/**
 * SHARED MESSAGE PROCESSING — used by both the recurring Inbox poll and the
 * one-time onboarding folder scan, so the classification/enrichment/send
 * logic only lives in one place.
 */
async function processMessage(gmail, m) {
  try {
    await processMessageInner(gmail, m);
  } catch (err) {
    // Guarantees every scanned email produces SOME log line — previously an
    // uncaught error here could silently swallow an email's outcome with no
    // trace at all beyond the initial "matched=..." line.
    console.error(`[${ts()}] Unexpected error processing id=${m.id}:`, err.response?.data || err.message || err);
  }
}

async function processMessageInner(gmail, m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);

  const full = await getEmail(gmail, m.id);
  const body = decodeEmail(full);

  const subjectHeader =
    full.payload?.headers?.find((h) => h.name === "Subject")?.value || "";
  const fromHeader =
    full.payload?.headers?.find((h) => h.name === "From")?.value || "";
  const dateHeader =
    full.payload?.headers?.find((h) => h.name === "Date")?.value || "";

  const text = `${subjectHeader}\n${body}`;
  if (looksLikeIsraeliEmploymentServiceNotice(text, fromHeader)) {
    console.log(`[${ts()}] [poll] id=${m.id} skipped (Israeli Employment Service visit/office notice, not an application)`);
    return;
  }

  const matched = isJobEmail(text);
  const nonEnglishCandidate =
    !matched &&
    looksNonEnglish(text) &&
    looksJobRelatedNonEnglish(text) &&
    !looksPromotional(text) &&
    !looksNonJobTransactional(text);

  console.log(
    `[${ts()}] [poll] id=${m.id} subject="${subjectHeader}" matched=${matched} nonEnglishCandidate=${nonEnglishCandidate}`
  );

  if (!matched && !nonEnglishCandidate) return;

  if (looksLikeAccountNotice(fromHeader)) {
    console.log(`[${ts()}] [poll] id=${m.id} skipped (Google account/security notification, not a job email)`);
    return;
  }

  if (looksLikePayment(text)) {
    console.log(`[${ts()}] [poll] id=${m.id} skipped (looks like a payment/purchase receipt)`);
    return;
  }

  if (looksLikeJobSuggestion(text)) {
    console.log(`[${ts()}] [poll] id=${m.id} skipped (looks like a job suggestion/recommendation digest)`);
    return;
  }

  const strongPhraseDetected = hasStrongConfirmationPhrase(text);
  const rejectionDetected = looksLikeRejection(text);
  const interviewStageDetected = looksLikeInterviewStage(text);
  const offerDetected = looksLikeOffer(text);

  let details = getCachedClassification(m.id);
  if (details) {
    console.log(`[${ts()}] [poll] id=${m.id} using cached classification (no Groq call)`);
  } else {
    // Throttle: spreads LLM calls out so a burst of matches in one poll cycle
    // (e.g. right after a restart) doesn't blow through Groq's per-minute
    // token cap. llama-3.1-8b-instant's free tier is 6,000 TPM — at roughly
    // ~1,200 tokens for a confirmed email's two calls combined, 8s spacing
    // keeps us under that even for several matches in a row.
    await sleep(8000);

    try {
      details = await classifyEmail({
        subject: subjectHeader,
        body,
        fromHeader,
        strongPhraseDetected,
        rejectionDetected,
        interviewStageDetected,
        offerDetected,
      });
      setCachedClassification(m.id, details);
    } catch (err) {
      console.error(`[${ts()}] Enrichment error (id=${m.id}):`, err.response?.data || err.message || err);
      return;
    }
  }

  // Rejection/interview/offer emails never go to WhatsApp (that's only for
  // the initial confirmation), but they DO matter for the dashboard. If this
  // company is already tracked, just move its status forward. If it isn't
  // (e.g. the original confirmation scrolled out of the scan window before
  // we ever saw it), backfill a full row now rather than silently dropping
  // the signal — better to see it at the wrong stage than not at all.
  const updateDashboard = async (status) => {
    if (updateApplicationStatus(details.company, status, details.position, dateHeader)) return true;
    try {
      const snapshot = await researchCompanyFromEvidence({ company: details.company, position: details.position, fromHeader, body, html: decodeEmailHtml(full) });
      upsertApplicationStatus({
        company: details.company,
        position: details.position,
        briefExplanation: snapshot.whatTheyDo,
        status,
        fallbackDate: dateHeader,
        sourceMessageId: m.id,
        research: { sources: snapshot.sources || [], confidence: snapshot.confidence || 0 },
      });
      return true;
    } catch (err) {
      console.error(`[${ts()}] Enrichment error backfilling ${details.company} (id=${m.id}):`, err.response?.data || err.message || err);
      return false;
    }
  };

  if (details.isRejection) {
    if (await updateDashboard("Rejected")) {
      console.log(`[${ts()}] [dashboard] id=${m.id} ${details.company} -> Rejected`);
    }
    return;
  }
  if (details.isInterviewStage) {
    if (await updateDashboard("In Progress")) {
      console.log(`[${ts()}] [dashboard] id=${m.id} ${details.company} -> In Progress`);
    }
    return;
  }
  if (details.isOffer) {
    if (await updateDashboard("Hired")) {
      console.log(`[${ts()}] [dashboard] id=${m.id} ${details.company} -> Hired`);
    }
    return;
  }

  const conflictingSignal = rejectionDetected || interviewStageDetected || offerDetected;
  if (!details.isApplicationConfirmation && !(strongPhraseDetected && !conflictingSignal)) {
    console.log(`[${ts()}] [poll] id=${m.id} skipped (not confirmed as an application)`);
    return;
  }

  if (!details.position || /not specified/i.test(details.position)) {
    details.position = extractPositionFromSubject(subjectHeader) || details.position;
  }

  // A restart re-scans the same window, so use the immutable Gmail message ID
  // to avoid duplicate processing. Different confirmation messages from the
  // same company are intentionally retained as separate applications.
  if (findApplication(details.company, details.position, m.id, dateHeader)) {
    console.log(`[${ts()}] [poll] id=${m.id} skipped (this confirmation was already tracked)`);
    return;
  }

  let enriched;
  try {
    const snapshot = await researchCompanyFromEvidence({ company: details.company, position: details.position, fromHeader, body, html: decodeEmailHtml(full) });
    enriched = formatConfirmationMessage(details, snapshot, dateHeader);
    addApplication({
      company: details.company,
      position: details.position,
      briefExplanation: snapshot.whatTheyDo,
      appliedDate: dateHeader,
      sourceMessageId: m.id,
      research: { sources: snapshot.sources || [], confidence: snapshot.confidence || 0 },
    });
  } catch (err) {
    console.error(`[${ts()}] Enrichment error (id=${m.id}):`, err.response?.data || err.message || err);
    return;
  }

  const recipient = activeRecipient || config.whatsapp.to;
  if (isWindowOpen(recipient)) {
    await sendWhatsApp(enriched, recipient);
  } else {
    const hadPendingAlready = (pendingMessages.get(recipient) || []).length > 0;
    console.log(`[${ts()}] [whatsapp] id=${m.id} 24h window closed for ${recipient}, queueing instead of sending`);
    queuePendingMessage(recipient, enriched);

    // Only ping once per batch — if they already have messages queued and
    // haven't replied yet, don't send another template on top of it.
    if (!hadPendingAlready) {
      await sendWhatsAppTemplate("job_application_update", "en", recipient);
    }
  }
}

async function scanFolderOnce(folderName) {
  try {
    const gmail = getGmailClient(userAuth);
    const messages = await listEmailsByFolder(gmail, folderName);
    console.log(`[onboarding] scanning folder "${folderName}": ${messages.length} messages`);
    for (const m of messages) {
      await processMessage(gmail, m);
    }
  } catch (err) {
    console.error("Folder scan error:", err);
  }
}

/**
 * EMAIL POLLING
 */
async function poll() {
  if (pollInProgress) return; // previous cycle still running, don't overlap
  if (!userAuth) return;

  pollInProgress = true;
  try {
    const gmail = getGmailClient(userAuth);
    const messages = await listEmails(gmail);

    for (const m of messages) {
      await processMessage(gmail, m);
    }
  } catch (err) {
    console.error("Poll error:", err);
  } finally {
    pollInProgress = false;
  }
}

setInterval(poll, 60000);

/**
 * START SERVER
 */
app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  console.log(`START HERE → http://localhost:${PORT}/auth/google`);
});
