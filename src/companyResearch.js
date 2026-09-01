import {
  askGroqForJson,
  extractSenderDomain,
  isAtsOrGenericDomain,
  formatReceivedDate,
} from "./enrich.js";
import { tavilySearch } from "./tavily.js";
import { firecrawlScrape } from "./firecrawl.js";

// Company Resolution Engine: Search -> Resolve -> Verify -> Crawl ->
// Cross-check -> Summarize. Tavily (web search) and Firecrawl (crawling the
// verified site) are called as plain REST APIs — this app has no MCP host,
// so this is the functional equivalent of "Tavily MCP" / "Firecrawl MCP".

const ATS_PROVIDER_NAMES = {
  greenhouse: "Greenhouse",
  "lever.co": "Lever",
  myworkday: "Workday",
  smartrecruiters: "SmartRecruiters",
  icims: "iCIMS",
  jobvite: "Jobvite",
  bamboohr: "BambooHR",
  ashbyhq: "Ashby",
  teamtailor: "Teamtailor",
  "breezy.hr": "Breezy",
  recruitee: "Recruitee",
};

// Aggregators/social/reference sites that regularly outrank a small
// company's own site in search results but are never the official website.
const NON_OFFICIAL_HOSTS = [
  "linkedin.com", "indeed.com", "glassdoor.com", "crunchbase.com",
  "wikipedia.org", "facebook.com", "twitter.com", "x.com", "instagram.com",
  "youtube.com", "bloomberg.com", "pitchbook.com", "owler.com", "zoominfo.com",
  "builtin.com", "github.com", "medium.com",
];

function isNonOfficialHost(domain) {
  return NON_OFFICIAL_HOSTS.some((h) => domain === h || domain.endsWith(`.${h}`));
}

function extractRawSenderDomain(fromHeader = "") {
  const match = fromHeader.match(/[\w.+-]+@([\w.-]+)/);
  return match ? match[1].toLowerCase() : null;
}

function detectAtsProvider(fromHeader) {
  const domain = extractRawSenderDomain(fromHeader);
  if (!domain) return null;
  for (const [keyword, name] of Object.entries(ATS_PROVIDER_NAMES)) {
    if (domain.includes(keyword)) return name;
  }
  return null;
}

function slugify(company = "") {
  return company.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Pulls plausible company-domain mentions out of a snippet of text — used to
// read a website mentioned on a company's LinkedIn page (e.g. LinkedIn often
// shows "Website: company.com" in its own search-result snippet) without
// ever scraping LinkedIn itself.
function extractDomainMentions(text = "") {
  const matches = text.match(/\b[a-z0-9-]+\.(?:com|io|ai|co|net|org|co\.il|co\.uk)\b/gi) || [];
  return [...new Set(matches.map((m) => m.toLowerCase()))].filter((d) => !d.includes("linkedin"));
}

// Common two-part TLDs where the registrable domain is the last THREE
// labels (e.g. "co.il"), not the usual last two — otherwise "wix.co.il"
// would incorrectly collapse to "co.il".
const TWO_PART_TLDS = new Set(["co.il", "co.uk", "com.au", "co.nz", "com.br", "co.jp", "co.in"]);

// Collapses a subdomain (e.g. "careers.wix.com") down to its registrable
// root ("wix.com") so a careers/jobs/blog subdomain aggregates evidence
// onto the same candidate as the company's root domain instead of
// competing against it and potentially winning as "the official website".
function rootDomain(domain) {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

// Search (Tavily) + Resolve + Verify: gathers candidate domains from the
// sender address and multiple web searches, scores each on how well it
// matches the company, and only accepts the top scorer if it clears a
// minimum confidence bar. Never guesses — returns "Not found" otherwise.
async function resolveOfficialWebsite({ company, position, fromHeader, location, recruiterName }) {
  const nonAtsSenderDomain = extractSenderDomain(fromHeader);
  const atsProvider = detectAtsProvider(fromHeader);
  const slug = slugify(company);

  const candidates = new Map();
  function addCandidate(domain, score, sourceUrl) {
    if (!domain) return;
    domain = domain.toLowerCase().replace(/^www\./, "");
    if (isAtsOrGenericDomain(domain) || isNonOfficialHost(domain)) return;
    const root = rootDomain(domain);
    const existing = candidates.get(root) || { score: 0, sources: new Set(), corroborated: false };
    existing.score = Math.max(existing.score, score);
    if (sourceUrl) existing.sources.add(sourceUrl);
    // Corroboration bonus: once a candidate is confirmed by more than one
    // distinct source (e.g. a general web search AND the company's own
    // LinkedIn page independently pointing at the same domain), that
    // agreement is itself meaningful evidence beyond whichever single
    // score happened to be highest — this is the actual "match web and
    // LinkedIn findings" step, not just running both searches in parallel.
    if (existing.sources.size >= 2 && !existing.corroborated) {
      existing.score = Math.min(100, existing.score + 15);
      existing.corroborated = true;
    }
    candidates.set(root, existing);
  }

  if (nonAtsSenderDomain) addCandidate(nonAtsSenderDomain, 60, null);

  const queries = [`"${company}" official website`, `site:linkedin.com/company "${company}"`];
  if (atsProvider) queries.push(`"${company}" ${atsProvider} careers`);
  if (position && !/not specified/i.test(position)) queries.push(`"${company}" ${position}`);
  if (location) queries.push(`"${company}" ${location}`);
  if (recruiterName) queries.push(`"${company}" "${recruiterName}"`);

  for (const query of queries) {
    const results = await tavilySearch(query, { maxResults: 5 });
    results.forEach((r, i) => {
      try {
        const snippet = `${r.title || ""} ${r.content || ""}`;
        const isLinkedInResult = /linkedin\.com\/company\//i.test(r.url);

        if (isLinkedInResult) {
          // Never scrape LinkedIn — only read what Tavily's own search
          // snippet already shows (e.g. a "Website: company.com" line).
          for (const mentioned of extractDomainMentions(snippet)) {
            addCandidate(mentioned, 35, r.url);
          }
          return;
        }

        const domain = new URL(r.url).hostname.toLowerCase().replace(/^www\./, "");
        let score = i === 0 ? 25 : i === 1 ? 15 : 5;
        if (slug && domain.replace(/\./g, "").includes(slug)) score += 30;
        if (domain === nonAtsSenderDomain) score += 20;
        if (company && snippet.toLowerCase().includes(company.toLowerCase())) score += 10;
        addCandidate(domain, score, r.url);
      } catch {
        // malformed result URL, skip
      }
    });
  }

  let best = null;
  for (const [domain, info] of candidates.entries()) {
    if (!best || info.score > best.score) best = { domain, ...info };
  }

  if (!best || best.score < 40) {
    return { website: "Not found", confidence: best ? best.score : 0, sourceUrls: [] };
  }

  return {
    website: `https://${best.domain}`,
    confidence: Math.min(best.score, 100),
    sourceUrls: [...best.sources],
  };
}

// Crawl (Firecrawl) — only ever called on an already-verified website.
// Probes a couple of the most likely informative paths rather than all nine
// listed in the guide, to keep latency/cost bounded.
//
// About-style pages are crawled and placed FIRST, ahead of the homepage —
// for large consumer-facing sites (Amazon, Deloitte, ...) the homepage is
// often dominated by deals/promo banners/nav rather than a genuine
// description, and each page is capped individually before concatenating
// so a long homepage can't silently crowd out a shorter but more
// substantive About page once the combined text is used downstream.
async function crawlVerifiedWebsite(website) {
  if (website === "Not found") return { content: "", pages: [] };

  const pages = [];
  const base = website.replace(/\/$/, "");

  for (const p of ["/about", "/about-us", "/company"]) {
    const content = await firecrawlScrape(`${base}${p}`);
    if (content) {
      pages.push({ url: `${base}${p}`, content: content.slice(0, 2500) });
      break;
    }
  }

  const home = await firecrawlScrape(website);
  if (home) pages.push({ url: website, content: home.slice(0, 2500) });

  const newsContent = await firecrawlScrape(`${base}/news`);
  if (newsContent) pages.push({ url: `${base}/news`, content: newsContent.slice(0, 1500) });

  return { content: pages.map((p) => p.content).join("\n\n"), pages };
}

// LinkedIn Discovery Strategy (addendum): Tavily search only, never
// scraped/logged into. Accepted only if the company name is actually
// present in the matched result — otherwise treated as "Not found".
// Returns the snippet alongside the URL so it can be used downstream as a
// secondary source to cross-check the facts pulled from the website crawl.
async function discoverLinkedIn({ company, website }) {
  const queries = [`site:linkedin.com/company "${company}"`];
  if (website && website !== "Not found") {
    const domain = website.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
    queries.push(`site:linkedin.com/company "${domain}"`);
  }

  for (const query of queries) {
    const results = await tavilySearch(query, { maxResults: 3 });
    for (const r of results) {
      if (!/linkedin\.com\/company\//i.test(r.url)) continue;
      const snippet = `${r.title || ""} — ${r.content || ""}`.trim();
      if (company && snippet.toLowerCase().includes(company.toLowerCase())) {
        return { url: r.url, snippet };
      }
    }
  }
  return { url: null, snippet: "" };
}

// Cross-check & Summarize: a Groq call grounded primarily in the crawled
// source text. For a company whose identity/website has been confidently
// VERIFIED (not guessed), well-established general knowledge is also
// allowed as a fallback where the crawled text is too thin or promotional
// to answer from — a crawled homepage/About page is not reliably better
// than what a large model already knows about e.g. Amazon or Deloitte, and
// forbidding that knowledge entirely was producing worse answers than the
// old memory-only approach. This stays off for companies we're NOT
// confident we've correctly identified, where the hallucination risk from
// guessing is real (ambiguous/uncommon names, unverified website).
async function synthesizeResearch({ company, position, website, crawlContent, linkedinSnippet, identityConfident }) {
  const sourceBlock = crawlContent
    ? `PRIMARY SOURCE (authoritative) — content crawled from the company's verified official website:\n${crawlContent}\n`
    : "No verified website content is available.\n";

  const linkedinBlock = linkedinSnippet
    ? `\nSECONDARY SOURCE (cross-check only) — search snippet from the company's LinkedIn page. Use this only to fill a gap the primary source didn't cover, or to cross-check the primary source. If it conflicts with the primary source, trust the primary source:\n${linkedinSnippet}\n`
    : "";

  const knowledgePolicy = identityConfident
    ? `"${company}" has been confidently identified as a real company (its official website was independently verified, not guessed). If the source text above is too thin, promotional, or off-topic to answer a field, you MAY use your own well-established general knowledge of "${company}" for that field instead of answering 'Not found' — but only for facts you are genuinely confident are correct and widely known (e.g. what the company broadly does, its general industry). Still use 'Not publicly disclosed'/'Not found' for anything precise you're not sure about (exact headcount, funding figures, HQ address). Prefer the source text above when it's genuinely descriptive; fall back to general knowledge only when it isn't.`
    : `This company's identity could NOT be confidently verified (its official website is unresolved or uncertain — there may be multiple companies with similar names). Do NOT use general/prior knowledge for any field here — rely only on the text provided above, and answer 'Not found' for anything not directly covered by it. Guessing here risks describing the wrong company entirely.`;

  const prompt = `You are building a verified company research snapshot for a job seeker who applied to "${position}" at "${company}". The official website has been resolved as: ${website}.
${sourceBlock}${linkedinBlock}
${knowledgePolicy}

Respond with ONLY valid JSON (no markdown fences, no commentary) in this exact shape:
{
  "headquarters": "city/country if stated in the source text above, else 'Not found'",
  "industry": "industry/category if stated above, else 'Not found'",
  "whatTheyDo": "2-4 sentence plain description of the company's actual business, or 'Not found' if genuinely unknown",
  "products": ["up to 3 short product/service names; empty array if none are known"],
  "companySize": "approximate employee count/range if known, else 'Not publicly disclosed'",
  "recentNews": ["up to 3 short recent-news highlights if mentioned in the source text above; empty array if none — never invent news"],
  "whyInteresting": "one short sentence on why this role/company could be interesting"
}

The source text above may be dominated by marketing copy, seasonal promotions/deals, surveys, culture/"join our team" pitches, navigation menus, or other filler that is NOT a genuine description of what the company does — do not summarize that filler as if it were the answer.

Never invent a specific fact (a number, a date, a headquarters city, a piece of news) that isn't genuinely known. When in doubt, answer 'Not found' rather than guessing.`;

  // llama-3.3-70b-versatile was deprecated by Groq (announced June 2026),
  // replaced with qwen/qwen3.6-27b — which Groq itself then deprecated
  // (email received 2026-09-01, decommissioned 2026-09-14) in favor of
  // qwen/qwen3.8-27b. This file isn't currently imported anywhere
  // (superseded by companyEvidence.js's evidence-first pipeline), updated
  // for consistency in case it's ever reactivated.
  return askGroqForJson(prompt, "qwen/qwen3.8-27b");
}

function fractionResolved(research) {
  const fields = [research.headquarters, research.industry, research.companySize];
  const resolvedCount = fields.filter((f) => f && !/not found/i.test(f)).length;
  const hasSummary = research.whatTheyDo && !/not found/i.test(research.whatTheyDo);
  return (resolvedCount + (hasSummary ? 1 : 0)) / (fields.length + 1);
}

// How much the LinkedIn snippet independently agrees with what the website
// crawl produced — the actual "match web and LinkedIn findings" cross-check,
// not just running both searches without comparing them.
function crossCheckAgreement(linkedinSnippet, synthesis) {
  if (!linkedinSnippet) return 0;
  const lower = linkedinSnippet.toLowerCase();
  let agreement = 0;
  if (synthesis.headquarters && !/not found/i.test(synthesis.headquarters) && lower.includes(synthesis.headquarters.toLowerCase())) {
    agreement += 10;
  }
  if (synthesis.industry && !/not found/i.test(synthesis.industry) && lower.includes(synthesis.industry.toLowerCase())) {
    agreement += 10;
  }
  return agreement;
}

export async function researchCompany({ company, position, fromHeader, body, html, location, recruiterName }) {
  const websiteResult = await resolveOfficialWebsite({ company, position, fromHeader, location, recruiterName });
  const { content: crawlContent, pages } = await crawlVerifiedWebsite(websiteResult.website);
  const linkedinResult = await discoverLinkedIn({ company, website: websiteResult.website }).catch(() => ({ url: null, snippet: "" }));

  // Only trust general knowledge as a fallback once the corroboration bonus
  // in resolveOfficialWebsite has actually kicked in (web search + LinkedIn
  // independently agreeing on the same domain) or the sender's own domain
  // matched directly — i.e. we're not guessing which "Amazon" or "Island"
  // this is.
  const identityConfident = websiteResult.website !== "Not found" && websiteResult.confidence >= 70;

  let synthesis;
  try {
    synthesis = await synthesizeResearch({
      company, position, website: websiteResult.website,
      crawlContent, linkedinSnippet: linkedinResult.snippet, identityConfident,
    });
  } catch (err) {
    console.error(`[companyResearch] synthesis failed for "${company}":`, err.response?.data || err.message || err);
    synthesis = {
      headquarters: "Not found", industry: "Not found", whatTheyDo: "Not found",
      products: [], companySize: "Not found", recentNews: [], whyInteresting: "Not found",
    };
  }

  const sources = [...new Set([
    ...(websiteResult.website !== "Not found" ? [websiteResult.website] : []),
    ...websiteResult.sourceUrls,
    ...pages.map((p) => p.url),
    ...(linkedinResult.url ? [linkedinResult.url] : []),
  ])];

  const companyIdentityConfidence = websiteResult.website !== "Not found"
    ? Math.min(95, websiteResult.confidence + 10)
    : 30;
  const crossCheck = crossCheckAgreement(linkedinResult.snippet, synthesis);
  const researchQuality = Math.min(100, Math.round(fractionResolved(synthesis) * 100) + crossCheck);
  const overall = Math.round((companyIdentityConfidence + websiteResult.confidence + researchQuality) / 3);

  return {
    company,
    position,
    officialWebsite: websiteResult.website,
    headquarters: synthesis.headquarters || "Not found",
    industry: synthesis.industry || "Not found",
    whatTheyDo: synthesis.whatTheyDo || "Not found",
    products: Array.isArray(synthesis.products) ? synthesis.products.slice(0, 3) : [],
    companySize: synthesis.companySize || "Not found",
    recentNews: Array.isArray(synthesis.recentNews) ? synthesis.recentNews.slice(0, 3) : [],
    whyInteresting: synthesis.whyInteresting || "Not found",
    linkedin: linkedinResult.url,
    sources,
    confidence: {
      companyIdentity: companyIdentityConfidence,
      officialWebsite: websiteResult.confidence,
      researchQuality,
      overall,
    },
  };
}

export function formatResearchMessage(details, research, dateHeader) {
  const productsBlock = research.products.length
    ? research.products.map((p) => `• ${p}`).join("\n")
    : "Not found";

  const newsBlock = research.recentNews.length
    ? research.recentNews.map((n) => `• ${n}`).join("\n")
    : "No notable recent news found";

  const sourcesBlock = research.sources.length
    ? research.sources.map((s) => `• ${s}`).join("\n")
    : "• No verified sources found";

  return `🚀 ApplyAndFly

We detected a new application update.

🏢 Company: ${research.company}
🌐 Official Website: ${research.officialWebsite}
💼 Position: ${research.position}
📍 Headquarters / Main Location: ${research.headquarters}
🏭 Industry: ${research.industry}

💡 What the company does:
${research.whatTheyDo}

🚀 Main Products / Services:
${productsBlock}

👥 Company Size: ${research.companySize}

📰 Recent News:
${newsBlock}

🎯 Why this role may be interesting:
${research.whyInteresting}

📊 Confidence:
Company Identity: ${research.confidence.companyIdentity}%
Official Website: ${research.confidence.officialWebsite}%
Research Quality: ${research.confidence.researchQuality}%
Overall: ${research.confidence.overall}%

🔗 Sources:
${sourcesBlock}

📅 Application received ${formatReceivedDate(dateHeader)}.

Good luck! 🍀`;
}
