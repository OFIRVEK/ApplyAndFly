import axios from "axios";
import { config } from "./config.js";

function stripCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}

function repairJson(text) {
  // Best-effort cleanup for the common ways a smaller model's JSON output
  // gets slightly malformed: trailing commas before a closing brace/bracket.
  return text.replace(/,(\s*[}\]])/g, "$1");
}

export async function askGroqForJson(prompt, model = "llama-3.1-8b-instant") {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${config.groq.apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  const cleaned = stripCodeFences(res.data.choices[0].message.content);
  try {
    return JSON.parse(cleaned);
  } catch {
    return JSON.parse(repairJson(cleaned));
  }
}

// Classifies a scanned email: is it a genuine application confirmation, a
// rejection, an interview/assessment stage, or an offer? Used both to decide
// whether to WhatsApp the user (only for a clean confirmation) and to update
// the dashboard's tracked status for a company already in the table
// (rejection/interview/offer all matter there, even though none of them get
// WhatsApp'd).
export async function classifyEmail({ subject, body, fromHeader, strongPhraseDetected, rejectionDetected, interviewStageDetected, offerDetected }) {
  const hintLines = [];
  if (strongPhraseDetected) {
    hintLines.push(
      `Note: an automated pre-scan found an explicit confirmation phrase (e.g. "thank you for applying" / "we received your application") somewhere in this email. That phrase alone does NOT settle it — plenty of rejection, interview, assessment, and offer emails open with the exact same wording before moving on to their actual content. Keep reading the full email before deciding.`
    );
  }
  if (rejectionDetected) {
    hintLines.push(
      `Note: an automated pre-scan found language elsewhere in this email that resembles a rejection/decline (e.g. "moving forward with other candidates", "unfortunately", "will not be proceeding"). This is a strong signal the email is a REJECTION — set isRejection to true in that case, even if the email also opens with a "thank you for applying"-style line.`
    );
  }
  if (interviewStageDetected) {
    hintLines.push(
      `Note: an automated pre-scan found language suggesting an interview/assessment stage (e.g. scheduling an interview, a coding challenge). This is a strong signal it is NOT the initial confirmation — set isInterviewStage to true in that case.`
    );
  }
  if (offerDetected) {
    hintLines.push(
      `Note: an automated pre-scan found language suggesting a job offer (e.g. "pleased to offer", "welcome to the team"). This is a strong signal it is an OFFER — set isOffer to true in that case.`
    );
  }
  const hintBlock = hintLines.length ? `\n${hintLines.join("\n")}\n` : "";

  const prompt = `You are reading an email a job seeker received. The email may be written in any language (e.g. Hebrew, Arabic, Spanish) — read and understand it regardless of language, but always respond in the English JSON shape below. The email may come from a third-party ATS/recruiting platform (e.g. Greenhouse, Lever, Workday, SmartRecruiters, LinkedIn Easy Apply, Indeed) rather than the hiring company's own domain — do not assume the sender's email domain is the company's website. Regardless of who sent it, identify the actual hiring company the application was submitted to.

Email subject: ${subject}
Email sender: ${fromHeader}
Email body (may be partial):
${body.slice(0, 1500)}
${hintBlock}
First decide: is this a direct confirmation that the recipient's OWN job application was received/submitted (e.g. "Thank you for applying", "We received your application", "Your application to X has been submitted")? Read the ENTIRE email before deciding — many rejection/interview/offer emails open with the same "thank you for applying" style line before moving on to their actual content. An opening thank-you does NOT make it a plain confirmation if the email goes on to reject, invite to an interview/assessment, or extend an offer.

For the "position" field: check the EMAIL SUBJECT LINE carefully, not just the body — job titles are very often stated there even when the body is generic (e.g. "Thank you for applying for the QA Engineer position at X", "We Got It: Thanks for applying for Flight Test & QA"). Only use "Not specified" if neither the subject nor the body names a role.

Default to false for isApplicationConfirmation. Only answer true if the email confirms the recipient's OWN application was received — not a rejection, not an interview/assessment invite, not an offer, and NOT a job the recipient hasn't applied to yet. Also answer false for: job recommendation/suggestion digests pitching a role the recipient has NOT applied to — these come from job boards, LinkedIn, or recruiting agencies and are phrased as an invitation to apply or a "we found this for you" pitch, in any language (English examples: "jobs you may like", "job alert", "new jobs for you"; a Hebrew example: "חשבנו עליך כשראינו את המשרה הזו" = "we thought of you when we saw this role" — this is a pitch to APPLY, not a confirmation that an application was already submitted). Also answer false for: banking/payment/transaction notifications (even ones with a reference/confirmation number), bills, invoices, receipts, shipping/delivery updates, subscription or account notices, government/insurance correspondence, or anything else not explicitly a clean application-received confirmation. This also includes ANY purchase/booking/reservation confirmation for something other than a job — concert or event tickets, restaurant reservations, flight/hotel bookings, online orders, deliveries, etc. — and ANY membership/loyalty-program/subscription/service sign-up confirmation (e.g. "Welcome to X Membership"), even if it uses the word "application" or "welcome" (a membership application, loan application, or software application is NOT a job application). Such emails can easily contain words that superficially look job-related (e.g. a seat "position", a "job well done" in marketing copy) — that is NOT a job application. Words like "confirmation," "welcome," "application," "position," or the presence of a reference number are NOT enough on their own — the email must be unmistakably confirming that the recipient ALREADY applied, not inviting them to.

Respond with ONLY valid JSON (no markdown fences, no commentary) in this exact shape:
{
  "isApplicationConfirmation": true or false,
  "isRejection": true or false,
  "isInterviewStage": true or false — true for an interview invitation, assessment/task request, or coding challenge (reached the interview stage, not yet an offer),
  "isOffer": true or false — true for an offer letter / offer of employment (the candidate got the job),
  "company": "the actual hiring company's name (best guess regardless of the other fields)",
  "position": "job title mentioned in the email, or 'Not specified' if unclear",
  "status": "short status phrase, e.g. 'Application received', 'Interview scheduled', 'Not selected', 'Offer extended'",
  "recruiterName": "name of a specific recruiter/contact person mentioned in the email, or null if none is named",
  "location": "job/office location mentioned in the email (city/country), or null if none is stated"
}`;

  return askGroqForJson(prompt);
}

// Deterministic backstop for when the LLM comes back with "Not specified" —
// job titles are frequently stated plainly in the subject line using one of
// a handful of common phrasings.
const POSITION_SUBJECT_PATTERNS = [
  /for the (.+?) position/i,
  /for (.+?) position/i,
  /applying for the (.+?) role/i,
  /applying for (.+?) role/i,
  /for the role of (.+?)(?:\s+at\b|$)/i,
  /applying for (.+?) at\b/i,
  /application for (.+?) at\b/i,
  /thanks for applying for (.+?)(?:\s+at\b|$)/i,
];

export function extractPositionFromSubject(subject = "") {
  for (const pattern of POSITION_SUBJECT_PATTERNS) {
    const match = subject.match(pattern);
    if (match?.[1]) return match[1].trim().replace(/[.,;:]+$/, "");
  }
  return null;
}

export function formatReceivedDate(dateHeader) {
  const parsed = dateHeader ? new Date(dateHeader) : null;
  if (!parsed || isNaN(parsed.getTime())) return "Date unavailable";
  return parsed.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function enrichCompanyOnce({ company, position, websiteBlurb }) {
  const websiteBlock = websiteBlurb
    ? `\nRaw text pulled from the company's official website (may include navigation/menu clutter mixed with real content — use judgment to find the genuine descriptive parts): ${websiteBlurb}\n\nPrefer this live content when it's genuinely descriptive — it's more current and reliable than memory, especially for smaller or less widely known companies.\n`
    : "";

  const prompt = `You are building a short company snapshot for a job seeker who applied to "${position}" at "${company}".
${websiteBlock}
Using your own general knowledge of "${company}"${websiteBlurb ? " combined with the website text above" : ""}, respond with ONLY valid JSON (no markdown fences, no commentary) in this exact shape:
{
  "employees": "approximate employee count if reasonably well known, else 'Not publicly disclosed'",
  "industry": "industry/category",
  "hq": "headquarters city, else 'Unknown'",
  "publicPrivate": "'Public company (TICKER)' or 'Private company', else 'Unknown'",
  "whatTheyDo": "1-2 sentence plain, specific description of what the company actually does"
}

Do not fabricate precise numbers you are not reasonably confident about — use 'Not publicly disclosed' or 'Unknown' instead of guessing. If you are not genuinely confident what this specific company does (there may be multiple companies with similar names), say so honestly in whatTheyDo (e.g. "Specific business area unclear") rather than guessing a plausible-sounding but potentially wrong industry.`;

  // This call only fires for emails already confirmed as genuine
  // applications — much lower volume than the classification step — so we
  // can afford the more capable model here for better accuracy without
  // meaningfully affecting the daily token budget.
  return askGroqForJson(prompt, "llama-3.3-70b-versatile");
}

const VAGUE_MARKERS = [
  "specific business area unclear",
  "business area is unclear",
  "not well-known",
  "not widely known",
  "unclear",
];

function isVagueDescription(text = "") {
  const lower = text.toLowerCase();
  return VAGUE_MARKERS.some((m) => lower.includes(m));
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

const JUNK_BLURB_PATTERNS = [
  /enable javascript/i,
  /cookie/i,
  /just a moment/i,
  /access denied/i,
  /are you a robot/i,
  /captcha/i,
];

export function isJunkText(text) {
  return JUNK_BLURB_PATTERNS.some((p) => p.test(text));
}

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPageText(url) {
  const { data: html } = await axios.get(url, {
    timeout: 3500,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ApplyAndFlyBot/1.0)" },
  });

  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
  );
  let metaDescription = descMatch ? decodeHtmlEntities(descMatch[1]).trim() : "";
  if (isJunkText(metaDescription)) metaDescription = "";

  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  let bodyExcerpt = bodyMatch
    ? decodeHtmlEntities(stripHtmlToText(bodyMatch[0])).slice(0, 500).trim()
    : "";
  if (isJunkText(bodyExcerpt)) bodyExcerpt = "";

  return [metaDescription, bodyExcerpt].filter(Boolean).join(" — ").trim();
}

// .co.il added given how many tracked companies turn out to be Israeli.
const CANDIDATE_TLDS = [".com", ".co.il", ".io", ".ai"];
const ABOUT_PATHS = ["/about", "/about-us"];

// Third-party ATS/job-board domains — if the sender's email comes from one
// of these, it tells us nothing about the hiring company's own site (it'd
// just summarize the ATS platform itself), so never try it directly.
// Substring match on purpose: ATS platforms often send from branded
// notification subdomains (e.g. "xsightlabs.comeet-notifications.com"),
// which an exact-suffix match on "comeet.co" would miss entirely.
export const ATS_DOMAIN_KEYWORDS = [
  "greenhouse", "lever.co", "myworkday", "smartrecruiters",
  "linkedin", "indeed.com", "comeet", "jobvite", "icims", "workable",
  "breezy.hr", "recruitee", "taleo", "successfactors", "bamboohr",
  "ashbyhq", "teamtailor", "personio", "applytojob", "hiremetch",
];
const GENERIC_MAIL_DOMAINS = ["gmail.com", "googlemail.com", "outlook.com", "yahoo.com", "hotmail.com"];

export function isAtsOrGenericDomain(domain) {
  if (GENERIC_MAIL_DOMAINS.includes(domain)) return true;
  return ATS_DOMAIN_KEYWORDS.some((k) => domain.includes(k));
}

export function extractSenderDomain(fromHeader = "") {
  const match = fromHeader.match(/[\w.+-]+@([\w.-]+)/);
  if (!match) return null;
  const domain = match[1].toLowerCase();
  if (isAtsOrGenericDomain(domain)) return null;
  return domain;
}

// Trackers/CDNs/social platforms that regularly show up in email HTML
// (logo images, share icons, analytics pixels) but are never the hiring
// company's own site.
const NOISE_DOMAIN_KEYWORDS = [
  "cloudfront", "sendgrid", "mailgun", "google-analytics", "doubleclick",
  "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com",
  "googletagmanager", "mailchimp", "hubspot", "sentry.io", "gstatic.com",
  "googleapis.com", "schema.org", "w3.org", "cdn.",
];

function isNoiseDomain(domain) {
  return isAtsOrGenericDomain(domain) || NOISE_DOMAIN_KEYWORDS.some((k) => domain.includes(k));
}

// ATS emails often include a "view your application" / "see job posting"
// link — sometimes that points to the company's own branded career page
// even when the SENDER address is the ATS's generic notification domain.
// This is just reading links out of an email already legitimately received,
// not scraping anything.
function extractCandidateDomainsFromBody(body = "", companySlug = "") {
  const urls = body.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  const domains = new Set();

  for (const url of urls) {
    try {
      const domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      if (!isNoiseDomain(domain)) domains.add(domain);
    } catch {
      // malformed URL, skip
    }
  }

  // Prefer domains that actually mention the company name.
  return [...domains].sort((a, b) => {
    const aMatch = companySlug && a.replace(/\./g, "").includes(companySlug) ? 0 : 1;
    const bMatch = companySlug && b.replace(/\./g, "").includes(companySlug) ? 0 : 1;
    return aMatch - bMatch;
  });
}

// Anchor text that signals "this link goes to our actual company site" —
// the strongest signal available, since it's the sender explicitly telling
// the reader what the link is. Only exists in the HTML version of an email.
const WEBSITE_LINK_TEXT_PATTERNS = [
  /visit our website/i, /our website/i, /company website/i,
  /career(s)? page/i, /about us/i, /learn more about us/i,
  /learn about us/i, /click here to learn/i, /visit us at/i,
  // Hebrew
  /האתר שלנו/, /עמוד קריירה/, /אודותינו/, /בקרו באתר/,
];

function extractDomainsFromHtmlLinks(html = "") {
  const domains = [];
  const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1];
    const linkText = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!WEBSITE_LINK_TEXT_PATTERNS.some((p) => p.test(linkText))) continue;
    try {
      const domain = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
      if (!isNoiseDomain(domain)) domains.push(domain);
    } catch {
      // relative/malformed URL, skip
    }
  }
  return domains;
}

async function tryDomain(domain) {
  let blurb = await fetchPageText(`https://${domain}`);

  // An About page usually has more substance than a homepage banner.
  for (const path of ABOUT_PATHS) {
    const aboutText = await fetchPageText(`https://${domain}${path}`).catch(() => "");
    if (aboutText) {
      blurb = [blurb, aboutText].filter(Boolean).join(" — ");
      break;
    }
  }

  return blurb.length >= 15 ? blurb.slice(0, 900) : "";
}

async function findWebsiteBlurb(company, fromHeader, body, html) {
  const tried = new Set();

  async function attempt(domain) {
    if (!domain || tried.has(domain)) return "";
    tried.add(domain);
    try {
      return await tryDomain(domain);
    } catch {
      return "";
    }
  }

  // 1. Explicit "Visit our website" / "Career page" style links — the
  // strongest signal, since the sender is directly telling us what the
  // link is. Only available from the HTML version of the email.
  if (html) {
    for (const domain of extractDomainsFromHtmlLinks(html)) {
      const blurb = await attempt(domain);
      if (blurb) return blurb;
    }
  }

  // 2. The sender's own domain, when it's not a third-party ATS/job-board —
  // often correct for smaller companies that email directly.
  const senderDomain = extractSenderDomain(fromHeader);
  {
    const blurb = await attempt(senderDomain);
    if (blurb) return blurb;
  }

  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "");

  // 3. Any other non-noise link embedded in the body — a "view job" or
  // "track application" link sometimes points to the company's own branded
  // career page even when the sender address is the ATS's generic domain.
  if (body) {
    const candidates = extractCandidateDomainsFromBody(body, slug).slice(0, 5);
    for (const domain of candidates) {
      const blurb = await attempt(domain);
      if (blurb) return blurb;
    }
  }

  if (!slug) return "";

  // 4. Last resort: guess from the company name + common TLDs.
  for (const tld of CANDIDATE_TLDS) {
    const blurb = await attempt(`${slug}${tld}`);
    if (blurb) return blurb;
  }
  return "";
}

// Only reaches for a live website when the LLM's own knowledge came back
// vague — most companies it already knows well, so this stays cheap (no
// extra network/LLM calls) while directly targeting the gap: smaller/niche
// companies it has no reliable training-data knowledge of.
export async function enrichCompany({ company, position, fromHeader, body, html }) {
  const first = await enrichCompanyOnce({ company, position });
  if (!isVagueDescription(first.whatTheyDo)) return first;

  console.log(`[enrich] "${company}" was vague, trying a website lookup`);
  const blurb = await findWebsiteBlurb(company, fromHeader, body, html).catch(() => "");
  if (!blurb) return first;

  console.log(`[enrich] found website content for "${company}" (${blurb.length} chars), retrying`);
  return enrichCompanyOnce({ company, position, websiteBlurb: blurb });
}

// The dashboard link is sent separately as a tappable CTA button (see
// server.js) rather than embedded as raw text here — WhatsApp only lets a
// button carry custom link text, plain message text can't.
export function formatConfirmationMessage(details, snapshot, dateHeader) {
  return `🚀 ApplyAndFly

We detected a new application update.

🏢 Company
${details.company}

💼 Position
${details.position}

📩 Status
${details.status}

📅 Timeline
Application received ${formatReceivedDate(dateHeader)}.

⭐ What they do
${snapshot.whatTheyDo}

Good luck! 🍀`;
}
