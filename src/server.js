import express from "express";
import axios from "axios";
import path from "path";
import crypto from "crypto";
import { config } from "./config.js";
import { oauth2Client, getAuthUrl, createUserOAuthClient } from "./auth.js";
import { getGmailClient, listEmails, listEmailsByFolder, getEmail, decodeEmail, decodeEmailHtml } from "./gmail.js";
import { isJobEmail, hasStrongConfirmationPhrase, looksLikeRejection, looksLikeInterviewStage, looksLikeOffer, looksNonEnglish, looksJobRelatedNonEnglish, looksPromotional, looksNonJobTransactional, looksLikePayment, looksLikeJobSuggestion, looksLikeAccountNotice, looksLikeIsraeliEmploymentServiceNotice } from "./processor.js";
import { sendWhatsApp, sendWhatsAppTemplate, sendWhatsAppCtaUrl } from "./whatsapp.js";
import { classifyEmail, extractPositionFromSubject, formatConfirmationMessage } from "./enrich.js";
import { researchCompanyFromEvidence } from "./companyEvidence.js";
import { addApplication, findApplication, updateApplicationStatus, updateApplicationStatusByThread, updateApplicationStatusByRow, upsertApplicationStatus, updateApplicationDescription, updateApplicationResearch, fillMissingResearchFromSiblings, removeApplicationsByCompany, getAllApplications } from "./store.js";
import { getCachedClassification, setCachedClassification } from "./classificationCache.js";
import { getUser, upsertUser, getAllUsers, getUserByDashboardToken, getUserByEmail } from "./users.js";
import { startOrRenewWatch, needsRenewal } from "./gmailWatch.js";
import { restoreAndMerge, restoreAndMergeObject } from "./backup.js";
import { OAuth2Client as GoogleIdTokenClient } from "google-auth-library";

const app = express();
// Captures the exact raw request bytes alongside the parsed body — needed
// to verify Meta's X-Hub-Signature-256 header on the WhatsApp webhook,
// since re-serializing the parsed JSON isn't guaranteed to byte-match what
// Meta actually signed (key order, whitespace).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const PORT = process.env.PORT || config.port || 3000;

/**
 * DASHBOARD — separate Express app, its own port, so it's independent of
 * the main app (auth/webhook) — matches the requirement that the dashboard
 * (2000) and the bot (3000) are two distinct listeners, not one shared one.
 * Every dashboard/API route below is gated on a per-user dashboard token —
 * there is no unauthenticated "see everyone's data" view anymore.
 */
const dashboardApp = express();
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 2000;

dashboardApp.use(express.json());
// The dashboard token travels in the URL path, so make sure browsers never
// hand that URL to third parties (Referrer-Policy) and never cache the
// token-bearing pages/API responses to shared disk (Cache-Control on the
// token-carrying routes only — static pages like the homepage stay
// cacheable).
dashboardApp.use((req, res, next) => {
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  if (req.path.startsWith("/dashboard/") || req.path.startsWith("/api/")) {
    res.set("Cache-Control", "no-store");
  }
  next();
});
dashboardApp.use(express.static(path.resolve(process.cwd(), "public")));

function resolveDashboardUser(req) {
  const token = req.get("X-Dashboard-Token") || req.query.token;
  return getUserByDashboardToken(token);
}

dashboardApp.get("/dashboard/:token", (req, res) => {
  const user = getUserByDashboardToken(req.params.token);
  if (!user) return res.status(404).send("Dashboard not found");
  res.sendFile(path.resolve(process.cwd(), "public", "dashboard.html"));
});

dashboardApp.get("/api/applications", (req, res) => {
  const user = resolveDashboardUser(req);
  if (!user) return res.status(401).json({ error: "Invalid dashboard token" });
  res.json(getAllApplications(user.waId));
});

dashboardApp.patch("/api/applications/status", (req, res) => {
  const user = resolveDashboardUser(req);
  if (!user) return res.status(401).json({ error: "Invalid dashboard token" });

  const { company, position, appliedDate, sourceMessageId, status } = req.body || {};
  const validStatuses = new Set(["Applied", "In Progress", "Rejected", "Hired"]);
  if (!company || !validStatuses.has(status)) {
    return res.status(400).json({ error: "A company and a valid status are required" });
  }

  const updated = updateApplicationStatusByRow({ waId: user.waId, company, position, appliedDate, sourceMessageId, status });
  if (!updated) return res.status(404).json({ error: "Application not found" });
  res.json({ updated: true });
});

// The dashboard also lives under the main app. Locally it remains available
// on :2000 for convenience; on Render the single public service exposes the
// same dashboard at https://your-domain/dashboard/<token>.
app.use(dashboardApp);

dashboardApp.listen(DASHBOARD_PORT, () => {
  console.log(`Dashboard running on http://localhost:${DASHBOARD_PORT}/dashboard/<token>`);
});

// Per-user background research-refresh jobs (dashboard "Refresh company
// info" button), keyed by WhatsApp ID — replaces the old single global job
// object so one user's refresh never shows as "running" for another user.
const researchRefreshJobs = new Map();

function getRefreshJob(waId) {
  return researchRefreshJobs.get(waId) || {
    running: false,
    startedAt: null,
    finishedAt: null,
    totalCompanies: 0,
    processedCompanies: 0,
    updatedRows: 0,
    skippedCompanies: 0,
    errors: [],
  };
}

// In-memory only: resets on every restart, so a restart re-scans the full
// maxResults window from scratch. Keyed by "waId:messageId" so two users'
// Gmail message IDs can never collide with each other.
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
// WhatsApp ID (phone number).
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

// Sends the confirmation body with the dashboard link as a tappable CTA
// button when one's available, plain text otherwise (e.g. before a user
// has finished onboarding and gotten a dashboard token). Shared between the
// immediate-send path and the queued/flush path so both render identically.
async function sendConfirmation(body, dashboardUrl, waId) {
  if (dashboardUrl) {
    await sendWhatsAppCtaUrl(body, "Dashboard Manager", dashboardUrl, waId);
  } else {
    await sendWhatsApp(body, waId);
  }
}

async function flushPendingMessages(waId) {
  const queued = pendingMessages.get(waId);
  if (!queued || queued.length === 0) return;
  pendingMessages.delete(waId);
  for (const message of queued) {
    await sendConfirmation(message.body, message.dashboardUrl, waId);
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

// Plain res.send(text) has no <title>, so the browser tab falls back to
// showing the raw URL instead of the app name — wrapping status pages in
// this keeps the tab readable as "ApplyAndFly".
function sendStatusPage(res, message) {
  res.set("Content-Type", "text/html").send(
    `<!doctype html><html><head><meta charset="utf-8"><title>ApplyAndFly</title></head><body style="font-family: sans-serif; padding: 2rem;">${message}</body></html>`
  );
}

/**
 * STEP 1: start OAuth
 */
app.get("/auth/google", (req, res) => {
  // Deliberately doesn't log the generated URL — it carries the CSRF state
  // token in plain text, and Render's logs shouldn't hold that even though
  // it's already single-use and short-lived.
  const url = getAuthUrl(createOAuthState());
  console.log("Redirecting to Google OAuth");
  res.redirect(url);
});

/**
 * STEP 2: OAuth callback
 */
app.get("/auth/google/callback", async (req, res) => {
  try {
    if (authInProgress) {
      return sendStatusPage(res, "Auth already processing...");
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

    // A bare browser visit to /auth/google (no WhatsApp context) is treated
    // as the configured owner identity, so it still works standalone; a
    // WhatsApp-initiated flow always carries a real waId.
    const waId = stateEntry.waId || config.whatsapp.to;

    const { tokens } = await oauth2Client.getToken(code);
    upsertUser(waId, { tokens });

    authInProgress = false;

    console.log(`✅ OAuth success. Tokens stored for ${waId}.`);

    // Capture the Gmail address (needed to route push notifications back to
    // this user) and start Gmail push notifications immediately, so new
    // mail is detected even if this server later goes idle. Best-effort —
    // if this fails, the coarse poll() safety net still covers this user.
    try {
      const gmail = getGmailClient(createUserOAuthClient(waId, tokens));
      const profile = await gmail.users.getProfile({ userId: "me" });
      upsertUser(waId, { emailAddress: profile.data.emailAddress });
      await startOrRenewWatch(waId, gmail);
    } catch (err) {
      console.error(`Failed to capture email/start watch for ${waId}:`, err.response?.data || err.message || err);
    }

    if (stateEntry.waId) {
      sessions.set(waId, { state: "awaiting_folder_answer" });
      await sendWhatsApp(
        `✅ Google connected!\n\nDo you have a folder where you moved your recent job application emails? If yes, reply with its name. If not, reply "Continue".`,
        waId
      );
      return sendStatusPage(res, "✅ Auth successful — check WhatsApp to finish setup.");
    }

    sendStatusPage(res, "✅ Auth successful. Bot is now running.");
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

// Verifies Meta actually sent this request — without this, anyone who finds
// the webhook URL could POST a forged payload claiming to be from any
// phone number. Only enforced when WHATSAPP_APP_SECRET is configured, so
// this doesn't break existing behavior for a deploy that hasn't set it yet.
function isValidWhatsAppSignature(req) {
  const appSecret = config.whatsapp.appSecret;
  // Fail closed: without the secret there is no way to tell Meta's real
  // webhook calls from forgeries, so reject everything rather than accept
  // everything (which is what this did before — one accidentally deleted
  // env var would have silently turned authentication off).
  if (!appSecret) {
    console.error("[whatsapp] WHATSAPP_APP_SECRET is not set — rejecting webhook POST (fail closed)");
    return false;
  }
  const signatureHeader = req.get("X-Hub-Signature-256");
  if (!signatureHeader || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post("/webhook/whatsapp", (req, res) => {
  if (!isValidWhatsAppSignature(req)) {
    console.error("[whatsapp] rejected webhook POST: invalid or missing signature");
    return res.sendStatus(403);
  }
  res.sendStatus(200); // ack immediately, Meta expects a fast response

  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message || message.type !== "text") return;

  const waId = message.from;
  const text = message.text?.body?.trim() || "";

  // Content deliberately not logged — users type whatever they want at the
  // bot, and message text in Render's logs would be readable by the
  // operator. Length + masked number is enough to trace webhook activity.
  console.log(`[whatsapp] inbound from ***${String(waId).slice(-4)} (${text.length} chars)`);

  handleIncomingWhatsAppMessage(waId, text).catch((err) =>
    console.error("Webhook handling error:", err)
  );
});

/**
 * GMAIL PUSH NOTIFICATIONS — Pub/Sub calls this the moment new mail arrives
 * for a watched mailbox, instead of the app having to poll for it. Works
 * even after this server has gone idle: the incoming request itself wakes
 * a sleeping Render instance, and Pub/Sub retries delivery if the first
 * attempt times out mid-wake-up.
 */
// Verifies the request actually came from Google Pub/Sub via the OIDC token
// it attaches when the subscription has authentication enabled — without
// this, anyone who finds the webhook URL could POST a forged notification
// claiming to be for any known Gmail address. Only enforced when
// GMAIL_PUBSUB_AUDIENCE is configured, so this doesn't break a deploy
// that hasn't set up authenticated push yet (the subscription itself needs
// a matching service-account configuration on Google's side).
const pubsubIdTokenClient = new GoogleIdTokenClient();
async function isValidPubSubRequest(req) {
  const audience = config.google.pubsubAudience;
  // Fail closed, same reasoning as the WhatsApp signature check above.
  if (!audience) {
    console.error("[gmail-push] GMAIL_PUBSUB_AUDIENCE is not set — rejecting push request (fail closed)");
    return false;
  }
  const authHeader = req.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return false;
  try {
    const ticket = await pubsubIdTokenClient.verifyIdToken({ idToken: token, audience });
    // Audience alone isn't proof the request came from OUR subscription —
    // anyone with any Google Cloud service account can mint a Google-signed
    // token for an arbitrary audience string. Pinning the token's identity
    // to the exact service account configured on the subscription closes
    // that: only tokens minted AS that account pass.
    const expectedServiceAccount = config.google.pubsubServiceAccount;
    if (expectedServiceAccount) {
      const payload = ticket.getPayload();
      const email = (payload?.email || "").toLowerCase();
      if (!payload?.email_verified || email !== expectedServiceAccount.toLowerCase()) {
        console.error(`[gmail-push] rejected: token from unexpected identity "${email || "(none)"}"`);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error("[gmail-push] rejected: invalid OIDC token:", err.message || err);
    return false;
  }
}

app.post("/webhook/gmail", async (req, res) => {
  if (!(await isValidPubSubRequest(req))) return res.sendStatus(403);
  res.sendStatus(200); // ack immediately, Pub/Sub expects a fast response

  handleGmailPush(req.body).catch((err) =>
    console.error("Gmail push handling error:", err)
  );
});

async function handleGmailPush(body) {
  const dataB64 = body?.message?.data;
  if (!dataB64) return;

  let notification;
  try {
    notification = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
  } catch (err) {
    console.error("[gmail-push] could not decode notification payload:", err.message || err);
    return;
  }

  const { emailAddress, historyId: newHistoryId } = notification;
  const user = getUserByEmail(emailAddress);
  if (!user) {
    console.log(`[gmail-push] notification for unknown address ${emailAddress}, ignoring`);
    return;
  }
  if (user.paused) {
    console.log(`[gmail-push] ${user.waId} is paused, ignoring notification`);
    return;
  }
  if (!user.historyId) {
    // No prior cursor to diff from yet (e.g. watch was just registered) —
    // just adopt this historyId as the new baseline rather than guessing.
    upsertUser(user.waId, { historyId: newHistoryId });
    return;
  }

  try {
    const gmail = getGmailClient(createUserOAuthClient(user.waId, user.tokens));
    const result = await gmail.users.history.list({
      userId: "me",
      startHistoryId: user.historyId,
      historyTypes: ["messageAdded"],
    });

    const messageIds = new Set();
    for (const record of result.data.history || []) {
      for (const added of record.messagesAdded || []) {
        if (added.message?.id) messageIds.add(added.message.id);
      }
    }

    console.log(`[gmail-push] ${user.waId}: ${messageIds.size} new message(s) since historyId=${user.historyId}`);
    for (const id of messageIds) {
      await processMessage(gmail, { id }, user.waId);
    }

    upsertUser(user.waId, { historyId: newHistoryId });
  } catch (err) {
    console.error(`[gmail-push] history.list failed for ${user.waId}:`, err.response?.data || err.message || err);
  }
}

/**
 * TEMPORARY DEBUG ROUTES — for manually backfilling a handful of dashboard
 * entries using an already-authenticated user's Gmail session. Pass
 * ?waId=<phone> to target a specific onboarded user; defaults to the
 * configured owner number. Not meant to stay in the app long-term.
 *
 * Previously gated only on the TARGET user having tokens, not on the
 * CALLER being anyone in particular — meaning anyone who found the URL and
 * knew (or guessed) a phone number could read that person's Gmail through
 * these endpoints. Now requires a shared secret (DEBUG_SECRET) as a query
 * param; if that env var isn't set at all, both routes are disabled
 * outright rather than left reachable with no way to authenticate.
 */
function requireDebugSecret(req, res) {
  const configured = config.debugSecret;
  const provided = req.query.secret;
  if (!configured || !provided) {
    res.status(404).send("Not found");
    return false;
  }
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(configured));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(404).send("Not found");
    return false;
  }
  return true;
}

app.get("/debug/search", async (req, res) => {
  if (!requireDebugSecret(req, res)) return;
  const waId = req.query.waId || config.whatsapp.to;
  const user = getUser(waId);
  if (!user?.tokens) return res.status(401).send("Not authenticated");
  try {
    const gmail = getGmailClient(createUserOAuthClient(waId, user.tokens));
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
  if (!requireDebugSecret(req, res)) return;
  const waId = req.query.waId || config.whatsapp.to;
  const user = getUser(waId);
  if (!user?.tokens) return res.status(401).send("Not authenticated");
  try {
    const gmail = getGmailClient(createUserOAuthClient(waId, user.tokens));
    const { messageId, company, position } = req.query;
    const full = await getEmail(gmail, messageId);
    const body = decodeEmail(full);
    const html = decodeEmailHtml(full);
    const fromHeader = full.payload?.headers?.find((h) => h.name === "From")?.value || "";

    const snapshot = await researchCompanyFromEvidence({ company, position, fromHeader, body, html });
    // Was updateApplicationDescription, which writes briefExplanation
    // unconditionally with no verification check and never touches
    // .research — that's how a row ends up with real sources sitting next
    // to a "Not verified" description. updateApplicationResearch applies
    // the same isVerifiedResearch-equivalent guard as the dashboard Refresh
    // button and keeps both fields consistent.
    const updated = isVerifiedResearch(snapshot) ? updateApplicationResearch(waId, company, snapshot) : 0;

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

// Same bar as isVerifiedResearch, applied to an already-stored row instead
// of a fresh snapshot — lets the refresh job tell "already has good,
// verified info" apart from "unverified/missing", so a re-research never
// clobbers a row that's already correct.
function isApplicationAlreadyVerified(application) {
  return isVerifiedResearch({
    confidence: application.research?.confidence || 0,
    sources: application.research?.sources || [],
    whatTheyDo: application.briefExplanation,
  });
}

async function refreshDashboardResearch(waId, companyFilter = null) {
  const user = getUser(waId);
  if (!user?.tokens) return;

  // A company's info never depends on which position was applied for, so
  // this runs first and for free: any row still missing data gets it
  // straight from an already-verified sibling at the same company before
  // spending a single search call on it below.
  const filledFromSiblings = fillMissingResearchFromSiblings(waId);

  const applications = getAllApplications(waId);
  const groups = new Map();
  for (const application of applications) {
    if (companyFilter && application.company.toLowerCase() !== companyFilter.toLowerCase()) continue;
    const key = application.company.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(application);
  }

  researchRefreshJobs.set(waId, {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalCompanies: groups.size,
    processedCompanies: 0,
    updatedRows: filledFromSiblings,
    skippedCompanies: 0,
    errors: [],
  });

  try {
    const gmail = getGmailClient(createUserOAuthClient(waId, user.tokens));
    for (const applicationsAtCompany of groups.values()) {
      const application = applicationsAtCompany[0];
      const job = researchRefreshJobs.get(waId);
      try {
        if (isApplicationAlreadyVerified(application)) {
          job.skippedCompanies += 1;
          continue;
        }

        const email = await findHistoricalConfirmation(gmail, application);
        if (!email) {
          job.skippedCompanies += 1;
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
          job.skippedCompanies += 1;
          continue;
        }

        job.updatedRows += updateApplicationResearch(waId, application.company, snapshot);
      } catch (err) {
        job.errors.push({
          company: application.company,
          message: err.response?.data?.error?.message || err.message || "Research failed",
        });
      } finally {
        job.processedCompanies += 1;
      }
    }
  } finally {
    const job = researchRefreshJobs.get(waId);
    if (job) {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
  }
}

// Runs entirely in the background and never sends WhatsApp. It refreshes a
// stored description only when the original confirmation email is found and
// the new research independently verifies the company/domain.
dashboardApp.post("/api/applications/refresh", (req, res) => {
  const user = resolveDashboardUser(req);
  if (!user) return res.status(401).json({ error: "Invalid dashboard token" });
  if (!user.tokens) return res.status(401).json({ error: "Reconnect Gmail first" });
  if (getRefreshJob(user.waId).running) return res.status(409).json(getRefreshJob(user.waId));

  const company = typeof req.query.company === "string" ? req.query.company.trim() : null;
  refreshDashboardResearch(user.waId, company || null).catch((err) => {
    console.error("Dashboard research refresh failed:", err);
  });
  res.status(202).json({ started: true });
});

dashboardApp.get("/api/applications/refresh-status", (req, res) => {
  const user = resolveDashboardUser(req);
  if (!user) return res.status(401).json({ error: "Invalid dashboard token" });
  res.json(getRefreshJob(user.waId));
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

  // STOP/START: a full per-user kill switch, independent of onboarding
  // state — pauses this user's own email checking and notifications only
  // (poll() and the Gmail push handler both skip paused users). Only
  // meaningful once onboarding has actually started; pausing something
  // that was never running is a no-op.
  const normalizedText = text.trim().toLowerCase();
  if (session && normalizedText === "stop") {
    upsertUser(waId, { paused: true });
    await sendWhatsApp(`⏸️ Paused. I won't check your Gmail or send updates until you reply "START".`, waId);
    return;
  }
  if (session && normalizedText === "start") {
    upsertUser(waId, { paused: false });
    await sendWhatsApp(`▶️ Resumed — back to watching your Inbox for new application confirmations.`, waId);
    return;
  }

  if (!session) {
    // `sessions` is in-memory only and resets on every restart/redeploy,
    // but the actual Gmail tokens live in the persisted user store and
    // survive just fine — so a missing session here doesn't mean this
    // person was never onboarded, only that this process forgot. Rehydrate
    // from the durable record instead of blindly restarting Google sign-in
    // on someone who's already connected (poll()/the push handler already
    // prove the tokens still work — they're what just sent this person's
    // notification in the first place).
    const existingUser = getUser(waId);
    if (existingUser?.tokens) {
      sessions.set(waId, { state: "onboarded", folder: existingUser.folder });
      return;
    }

    sessions.set(waId, { state: "awaiting_oauth" });
    const authUrl = getAuthUrl(createOAuthState(waId));
    await sendWhatsAppCtaUrl(
      "👋 Hey, thanks for choosing ApplyAndFly as your applications manager!\n\nFirst, sign in with Google so I can read your Gmail:",
      "Sign in with Google", // WhatsApp caps CTA button display_text at 20 characters
      authUrl,
      waId
    );
    return;
  }

  if (session.state === "awaiting_folder_answer") {
    const folder = text.toLowerCase() === "continue" ? null : text;

    // Each user gets their own unguessable dashboard link — nobody else can
    // view or modify their data, not even by knowing their WhatsApp number.
    // Generated BEFORE the backfill scans below (not after) so every
    // notification sent during backfill already has it attached, not just
    // ones sent afterward — this was a real bug: the token used to only
    // get created once the scans finished, so every historical-application
    // notification during onboarding shipped with no dashboard link at all.
    const dashboardToken = crypto.randomBytes(24).toString("hex");
    upsertUser(waId, { folder, dashboardToken });

    // Backfill existing applications before switching to "watch for new
    // ones" mode — the dashboard should start populated, not empty. The
    // named folder (if any) is scanned in addition to the Inbox, not
    // instead of it, since ongoing detection always watches the Inbox.
    await sendWhatsApp(
      folder
        ? `Got it — scanning "${folder}" and your Inbox for existing applications first. This might take a bit...`
        : `Got it — scanning your Inbox for existing applications first. This might take a bit...`,
      waId
    );

    if (folder) {
      await scanFolderOnce(waId, folder);
    }

    const user = getUser(waId);
    if (user?.tokens) {
      const gmail = getGmailClient(createUserOAuthClient(waId, user.tokens));
      await scanInboxOnce(waId, gmail);
    }

    sessions.set(waId, { state: "onboarded", folder });

    await sendWhatsApp(
      `✅ All set! I'll keep watching your Inbox for new application confirmations.`,
      waId
    );

    if (config.app.publicUrl) {
      await sendWhatsAppCtaUrl(
        "📊 Here's your personal dashboard — only you can see it:",
        "Open Dashboard",
        `${config.app.publicUrl}/dashboard/${dashboardToken}`,
        waId
      );
    }
  }
}

/**
 * SHARED MESSAGE PROCESSING — used by both the recurring Inbox poll and the
 * one-time onboarding folder scan, so the classification/enrichment/send
 * logic only lives in one place. Scoped throughout to a specific waId so
 * concurrently-onboarded users never see or affect each other's data.
 */
async function processMessage(gmail, m, waId) {
  try {
    await processMessageInner(gmail, m, waId);
  } catch (err) {
    // Guarantees every scanned email produces SOME log line — previously an
    // uncaught error here could silently swallow an email's outcome with no
    // trace at all beyond the initial "matched=..." line.
    console.error(`[${ts()}] Unexpected error processing id=${m.id} for ${waId}:`, err.response?.data || err.message || err);
    // This is the catch-all for every failure path in processMessageInner,
    // including the unguarded getEmail() call at its very top — without
    // this, a single transient Gmail API hiccup permanently blacklists that
    // email from ever being looked at again for the rest of this process's
    // uptime, since `seen` would still mark it done. Release it so the next
    // poll cycle retries instead of silently never showing it anywhere.
    seen.delete(`${waId}:${m.id}`);
  }
}

async function processMessageInner(gmail, m, waId) {
  const seenKey = `${waId}:${m.id}`;
  if (seen.has(seenKey)) return;
  seen.add(seenKey);

  const full = await getEmail(gmail, m.id);
  const body = decodeEmail(full);

  const subjectHeader =
    full.payload?.headers?.find((h) => h.name === "Subject")?.value || "";
  const fromHeader =
    full.payload?.headers?.find((h) => h.name === "From")?.value || "";
  const dateHeader =
    full.payload?.headers?.find((h) => h.name === "Date")?.value || "";
  const threadId = full.threadId || null;

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

  // Deliberately does NOT log the subject line — this line fires for EVERY
  // scanned email (bank notices, personal mail, everything in the window),
  // so logging subjects would put users' raw inbox content in Render's logs
  // for the operator to see. The Gmail message ID is enough to investigate
  // a specific email's handling: the mailbox owner can look it up, the
  // operator alone can't. waId is masked to its last 4 digits for the same
  // reason (it's a full phone number).
  console.log(
    `[${ts()}] [poll] id=${m.id} waId=***${String(waId).slice(-4)} matched=${matched} nonEnglishCandidate=${nonEnglishCandidate}`
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
      console.error(`[${ts()}] Enrichment error [classify] (id=${m.id}):`, err.response?.data || err.message || err);
      seen.delete(seenKey);
      return;
    }
  }

  // eventType alone routes the email — a new confirmation always sends the
  // WhatsApp message and gets added to the dashboard, exactly as before;
  // there's no confidence-based withholding. "uncertain"/"non_job"/
  // "recommendation" are the classifier's own way of saying this isn't a
  // job-application-related email at all, so those are skipped regardless.
  if (details.eventType === "non_job" || details.eventType === "recommendation" || details.eventType === "uncertain") {
    console.log(`[${ts()}] [poll] id=${m.id} skipped (eventType=${details.eventType})`);
    return;
  }

  // Rejection/interview/offer emails never go to WhatsApp (that's only for
  // the initial confirmation), but they DO matter for the dashboard. Thread
  // continuity is checked first — a status update is very often a reply in
  // the SAME Gmail thread as the original confirmation, which is a
  // structural signal from the email system itself, not a guessed text
  // match — before falling back to company+position matching. If neither
  // finds this company tracked (e.g. the original confirmation scrolled out
  // of the scan window before we ever saw it), backfill a full row now
  // rather than silently dropping the signal — better to see it at the
  // wrong stage than not at all.
  const updateDashboard = async (status) => {
    if (updateApplicationStatusByThread(waId, threadId, status)) return true;
    if (updateApplicationStatus(waId, details.company, status, details.position, dateHeader)) return true;
    try {
      const snapshot = await researchCompanyFromEvidence({ company: details.company, position: details.position, fromHeader, body, html: decodeEmailHtml(full) });
      upsertApplicationStatus({
        waId,
        company: details.company,
        position: details.position,
        briefExplanation: snapshot.whatTheyDo,
        status,
        fallbackDate: dateHeader,
        sourceMessageId: m.id,
        threadId,
        research: { sources: snapshot.sources || [], confidence: snapshot.confidence || 0 },
      });
      return true;
    } catch (err) {
      console.error(`[${ts()}] Enrichment error backfilling ${details.company} (id=${m.id}):`, err.response?.data || err.message || err);
      seen.delete(seenKey);
      return false;
    }
  };

  if (details.eventType === "rejection") {
    if (await updateDashboard("Rejected")) {
      console.log(`[${ts()}] [dashboard] id=${m.id} ${details.company} -> Rejected`);
    }
    return;
  }
  if (details.eventType === "interview") {
    if (await updateDashboard("In Progress")) {
      console.log(`[${ts()}] [dashboard] id=${m.id} ${details.company} -> In Progress`);
    }
    return;
  }
  if (details.eventType === "offer") {
    if (await updateDashboard("Hired")) {
      console.log(`[${ts()}] [dashboard] id=${m.id} ${details.company} -> Hired`);
    }
    return;
  }

  // Only "application_confirmation" reaches here.
  if (!details.position || /not specified/i.test(details.position)) {
    details.position = extractPositionFromSubject(subjectHeader) || details.position;
  }

  // A restart re-scans the same window, so use the immutable Gmail message ID
  // to avoid duplicate processing. Different confirmation messages from the
  // same company are intentionally retained as separate applications.
  if (findApplication(waId, details.company, details.position, m.id, dateHeader)) {
    console.log(`[${ts()}] [poll] id=${m.id} skipped (this confirmation was already tracked)`);
    return;
  }

  let enrichedBody;
  let dashboardUrl;
  try {
    const snapshot = await researchCompanyFromEvidence({ company: details.company, position: details.position, fromHeader, body, html: decodeEmailHtml(full) });
    const user = getUser(waId);
    dashboardUrl = user?.dashboardToken && config.app.publicUrl
      ? `${config.app.publicUrl}/dashboard/${user.dashboardToken}`
      : null;
    enrichedBody = formatConfirmationMessage(details, snapshot, dateHeader);
    addApplication({
      waId,
      company: details.company,
      position: details.position,
      threadId,
      briefExplanation: snapshot.whatTheyDo,
      appliedDate: dateHeader,
      sourceMessageId: m.id,
      research: { sources: snapshot.sources || [], confidence: snapshot.confidence || 0 },
    });
  } catch (err) {
    console.error(`[${ts()}] Enrichment error [research] (id=${m.id}):`, err.response?.data || err.message || err);
    seen.delete(seenKey);
    return;
  }

  if (isWindowOpen(waId)) {
    await sendConfirmation(enrichedBody, dashboardUrl, waId);
  } else {
    const hadPendingAlready = (pendingMessages.get(waId) || []).length > 0;
    console.log(`[${ts()}] [whatsapp] id=${m.id} 24h window closed for ${waId}, queueing instead of sending`);
    queuePendingMessage(waId, { body: enrichedBody, dashboardUrl });

    // Only ping once per batch — if they already have messages queued and
    // haven't replied yet, don't send another template on top of it.
    if (!hadPendingAlready) {
      await sendWhatsAppTemplate("job_application_update", "en", waId);
    }
  }
}

async function scanFolderOnce(waId, folderName) {
  try {
    const user = getUser(waId);
    if (!user?.tokens) return;
    const gmail = getGmailClient(createUserOAuthClient(waId, user.tokens));
    const messages = await listEmailsByFolder(gmail, folderName);
    console.log(`[onboarding] scanning folder "${folderName}" for ${waId}: ${messages.length} messages`);
    for (const m of messages) {
      await processMessage(gmail, m, waId);
    }
  } catch (err) {
    console.error("Folder scan error:", err);
  }
}

// Backfills existing Inbox applications — used both at onboarding (so the
// dashboard starts populated with everything already there, not just
// whatever arrives afterward) and by poll()'s recurring safety-net scan.
async function scanInboxOnce(waId, gmail) {
  const messages = await listEmails(gmail);
  console.log(`[onboarding] scanning Inbox for ${waId}: ${messages.length} messages`);
  for (const m of messages) {
    await processMessage(gmail, m, waId);
  }
}

/**
 * EMAIL POLLING — no longer the primary detection path (Gmail push
 * notifications are); this is now a coarse safety net plus watch-renewal
 * job. Runs every 30 minutes rather than every 60 seconds: (1) re-registers
 * any user's Gmail watch that's approaching its ~7-day expiration, and
 * (2) does a traditional scan per user in case a push notification was
 * ever missed (e.g. Pub/Sub not yet configured, or a delivery genuinely
 * failed). Iterates every onboarded, non-paused user independently, each
 * with their own Gmail client — one user's failure doesn't stop the others.
 */
// Render's "sleep" is a full process restart, not a real suspend/resume —
// so a watch that only ever gets (re)registered inside poll()'s 30-minute
// timer can go a long time without ever actually happening if the process
// keeps restarting before that timer fires once. Called both at boot (so
// every wake-up immediately re-establishes push, no waiting required) and
// inside poll() (so a long-lived, never-sleeping instance still renews
// before the ~7-day expiration).
async function ensureWatchesRegistered() {
  for (const user of getAllUsers()) {
    if (!user.tokens || user.paused) continue;
    if (!needsRenewal(user)) continue;
    try {
      const gmail = getGmailClient(createUserOAuthClient(user.waId, user.tokens));
      await startOrRenewWatch(user.waId, gmail);
    } catch (err) {
      console.error(`Watch registration error for ${user.waId}:`, err.response?.data || err.message || err);
    }
  }
}

async function poll() {
  if (pollInProgress) return; // previous cycle still running, don't overlap

  pollInProgress = true;
  try {
    await ensureWatchesRegistered();
    for (const user of getAllUsers()) {
      if (!user.tokens || user.paused) continue;
      try {
        const gmail = getGmailClient(createUserOAuthClient(user.waId, user.tokens));
        await scanInboxOnce(user.waId, gmail);
      } catch (err) {
        console.error(`Poll error for ${user.waId}:`, err.response?.data || err.message || err);
      }
    }
  } finally {
    pollInProgress = false;
  }
}

const POLL_INTERVAL_MS = 30 * 60 * 1000;

/**
 * RESTORE FROM BACKUP — must complete before any traffic is accepted
 * (poll cycles, Gmail push, WhatsApp webhook), so the existing
 * sourceMessageId dedup in store.js sees full prior history on the very
 * first scan after a restart instead of an empty file. Top-level await
 * blocks the rest of this module — including setInterval/app.listen below
 * — until both restores finish. No-ops safely if GCS isn't configured.
 */
await restoreAndMerge(
  path.resolve(process.cwd(), "applications.json"),
  "applications.json",
  (a) => a.sourceMessageId || `${a.waId}:${a.company}:${a.position}:${a.appliedDate}`
);
await restoreAndMerge(
  path.resolve(process.cwd(), "users.json"),
  "users.json",
  (u) => u.waId
);
// classificationCache.json/companyIdentityCache.json: same "must survive a
// redeploy" reasoning as applications.json/users.json above — without this,
// every redeploy wiped local disk and the next scan re-burned real LLM/Serper
// quota re-classifying/re-resolving things that were already handled before
// the redeploy killed the process.
await restoreAndMergeObject(
  path.resolve(process.cwd(), "classificationCache.json"),
  "classificationCache.json"
);
await restoreAndMergeObject(
  path.resolve(process.cwd(), "companyIdentityCache.json"),
  "companyIdentityCache.json"
);

/**
 * START SERVER — before the initial poll, not after. A redeploy killing a
 * scan mid-flight (the new process's `seen` set is empty, but nothing
 * re-scans the inbox to rediscover that email until poll()'s first tick —
 * up to 30 minutes later — and Gmail push won't re-report it either, since
 * the new watch's baseline is already past it) is exactly why poll() also
 * runs once immediately below. But it must not block app.listen(): each
 * uncached email classification sleeps 8s, so a slow first scan would leave
 * WhatsApp/Gmail webhooks unreachable for however long that takes. Starting
 * the server first, then firing the catch-up poll in the background, gets
 * both — no missed mail, and no webhook downtime waiting for it.
 */
app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  console.log(`START HERE → http://localhost:${PORT}/auth/google`);
});

poll().catch((err) => console.error("Initial poll failed:", err.response?.data || err.message || err));
setInterval(poll, POLL_INTERVAL_MS);

/**
 * KEEP-ALIVE — Render's free tier spins the service down after ~15 minutes
 * without inbound HTTP, and the wake-up is a 30-60s cold start that hits
 * whoever opens the dashboard next (plus it delays Gmail push handling
 * until Pub/Sub's retry lands). Pinging our own public URL every 10
 * minutes keeps traffic flowing through Render's edge so it never sleeps.
 * The free tier's 750 instance-hours/month covers one service running
 * 24/7 (max 744h in a month), so staying awake costs nothing. Only active
 * when PUBLIC_APP_URL is set — locally there's nothing to keep awake.
 */
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;
if (config.app.publicUrl) {
  setInterval(() => {
    axios.get(config.app.publicUrl, { timeout: 20000 })
      .catch((err) => console.error("[keep-alive] self-ping failed:", err.message || err));
  }, KEEP_ALIVE_INTERVAL_MS);
  console.log(`[keep-alive] self-ping every ${KEEP_ALIVE_INTERVAL_MS / 60000} minutes -> ${config.app.publicUrl}`);
}
