import axios from "axios";
import { askGroqForJson, extractSenderDomain, isAtsOrGenericDomain } from "./enrich.js";
import { assertPublicHostname, MAX_PAGE_BYTES, isTextContentType } from "./netGuard.js";
import { tavilySearch } from "./tavily.js";
import { getCachedCompanyIdentity, setCachedCompanyIdentity } from "./companyIdentityCache.js";

// Evidence-first company research.
//
// This module deliberately resolves and verifies the company/domain BEFORE it
// asks the LLM to write anything. The LLM receives only evidence gathered from
// the verified official site, plus identity corroboration from search results.

const BLOCKED_HOSTS = [
  "linkedin.com", "indeed.com", "glassdoor.com", "crunchbase.com", "wikipedia.org",
  "facebook.com", "instagram.com", "x.com", "twitter.com", "youtube.com", "github.com",
  "greenhouse.io", "lever.co", "myworkdayjobs.com", "smartrecruiters.com", "workday.com",
  "googletagmanager.com", "googleapis.com", "gstatic.com", "doubleclick.net",
  "sendgrid.net", "mailgun.org", "hubspot.com", "mailchimp.com", "cloudfront.net",
];

const TWO_PART_TLDS = new Set(["co.il", "co.uk", "com.au", "co.nz", "com.br", "co.jp", "co.in"]);
const NAVIGATION_KEYWORDS = [
  "about", "company", "who we are", "our story", "what we do", "products", "product",
  "platform", "solutions", "services", "technology", "customers",
];

function rootDomain(domain = "") {
  const parts = domain.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_PART_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function hostFromUrl(value = "") {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isBlockedHost(domain = "") {
  return !domain || isAtsOrGenericDomain(domain) || BLOCKED_HOSTS.some((host) =>
    domain === host || domain.endsWith(`.${host}`)
  );
}

function normalize(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function companyMatches(value = "", company = "") {
  const haystack = normalize(value);
  const needle = normalize(company);
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;

  const words = company.toLowerCase().match(/[a-z0-9]+/g) || [];
  // A two-word-or-longer company name can legitimately appear with legal
  // suffixes omitted, e.g. "Check Point" vs "Check Point Software Technologies".
  return words.length >= 2 && words.every((word) => normalize(value).includes(word));
}

function decodeHtml(text = "") {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function cleanText(html = "") {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html = "", names = []) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeHtml(match[1]).trim();
    }
  }
  return "";
}

function flattenJsonLd(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => flattenJsonLd(entry, output));
  } else if (value && typeof value === "object") {
    output.push(value);
    if (value["@graph"]) flattenJsonLd(value["@graph"], output);
  }
  return output;
}

function extractOrganizations(html = "") {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const organizations = [];

  for (const script of scripts) {
    const content = script.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try {
      for (const item of flattenJsonLd(JSON.parse(content))) {
        const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
        if (types.some((type) => /organization|corporation|localbusiness|brand/i.test(String(type)))) {
          organizations.push({
            name: item.name || "",
            description: item.description || "",
            url: item.url || "",
            sameAs: Array.isArray(item.sameAs) ? item.sameAs : [],
            address: typeof item.address === "string" ? item.address : [item.address?.addressLocality, item.address?.addressCountry].filter(Boolean).join(", "),
          });
        }
      }
    } catch {
      // Invalid JSON-LD is common. The page's visible metadata remains usable.
    }
  }
  return organizations;
}

function extractInternalLinks(html, pageUrl, expectedRoot) {
  const links = [];
  const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    try {
      const url = new URL(match[1], pageUrl);
      if (!["http:", "https:"].includes(url.protocol) || rootDomain(url.hostname) !== expectedRoot) continue;
      const label = cleanText(match[2]).toLowerCase();
      if (!NAVIGATION_KEYWORDS.some((keyword) => label.includes(keyword) || url.pathname.toLowerCase().includes(keyword.replace(/\s+/g, "-")))) continue;
      url.hash = "";
      links.push({ url: url.toString(), label });
    } catch {
      // Ignore malformed/relative values that cannot be resolved.
    }
  }
  return [...new Map(links.map((link) => [link.url, link])).values()].slice(0, 2);
}

// SSRF guard lives in netGuard.js (shared with enrich.js's website-blurb
// fetcher); redirects are still re-validated per hop here.
async function fetchPage(url, redirectsLeft = 4) {
  const hostname = new URL(url).hostname;
  await assertPublicHostname(hostname);

  const response = await axios.get(url, {
    timeout: 8000,
    maxRedirects: 0, // handled manually below so every hop gets re-validated
    maxContentLength: MAX_PAGE_BYTES,
    maxBodyLength: MAX_PAGE_BYTES,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ApplyAndFly/1.0; company research)" },
    responseType: "text",
    validateStatus: (status) => status >= 200 && status < 400,
  });

  if (response.status >= 300 && response.status < 400 && response.headers.location) {
    if (redirectsLeft <= 0) throw new Error(`too many redirects fetching ${url}`);
    const nextUrl = new URL(response.headers.location, url).toString();
    return fetchPage(nextUrl, redirectsLeft - 1);
  }

  // Only text is ever parsed below — a binary response (PDF, zip, video)
  // would just be garbage input, so don't even try.
  if (!isTextContentType(response.headers["content-type"])) {
    throw new Error(`non-text content-type fetching ${url}`);
  }

  const html = typeof response.data === "string" ? response.data : "";
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const description = metaContent(html, ["description", "og:description", "twitter:description"]);
  const siteName = metaContent(html, ["og:site_name", "application-name"]);
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || url;
  const organizations = extractOrganizations(html);
  const body = cleanText(html).slice(0, 2600);

  return { url: canonical, html, title, description, siteName, organizations, body };
}

function addCandidate(candidates, domain, evidence) {
  const host = domain?.toLowerCase().replace(/^www\./, "");
  if (isBlockedHost(host)) return;
  const root = rootDomain(host);
  const existing = candidates.get(root) || { domain: root, score: 0, evidence: [], sourceUrls: new Set(), verifiedSite: null, fetchedSite: null };
  existing.score += evidence.score;
  existing.evidence.push(evidence);
  if (evidence.url) existing.sourceUrls.add(evidence.url);
  candidates.set(root, existing);
}

function addDomainsFromEmail(candidates, body, html) {
  const rawUrls = new Set(body.match(/https?:\/\/[^\s"'<>)]+/g) || []);
  for (const href of html.matchAll(/href=["']([^"']+)["']/gi)) rawUrls.add(href[1]);

  for (const rawUrl of rawUrls) {
    const host = hostFromUrl(rawUrl);
    if (!host || isBlockedHost(host)) continue;
    addCandidate(candidates, host, { type: "application-email-link", score: 28, url: rawUrl });
  }
}

function extractDomainMentions(text = "") {
  return [...new Set((text.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[\w./?=&%-]*)?/gi) || [])
    .map((value) => hostFromUrl(value.startsWith("http") ? value : `https://${value}`))
    .filter(Boolean))];
}

// Runs a batch of Tavily search queries and folds the results into
// `candidates` by score. Returns only THIS round's LinkedIn hits (not
// accumulated across calls) so a caller running a second round never
// re-scores the same LinkedIn snippet twice.
async function searchAndScoreCandidates(candidates, queries, company) {
  const resultGroups = await Promise.all(queries.map((query) => tavilySearch(query, { maxResults: 5 })));
  const linkedinResults = [];
  for (let groupIndex = 0; groupIndex < resultGroups.length; groupIndex += 1) {
    for (let index = 0; index < resultGroups[groupIndex].length; index += 1) {
      const result = resultGroups[groupIndex][index];
      const text = `${result.title || ""} ${result.content || ""}`;
      if (/linkedin\.com\/company\//i.test(result.url || "")) {
        if (companyMatches(text, company)) linkedinResults.push({ url: result.url, text });
        continue;
      }

      const host = hostFromUrl(result.url);
      if (!host || isBlockedHost(host)) continue;
      let score = Math.max(8, 25 - index * 4);
      if (companyMatches(text, company)) score += 15;
      if (normalize(host).includes(normalize(company))) score += 10;
      addCandidate(candidates, host, { type: "web-search", score, url: result.url });
    }
  }

  // LinkedIn is never fetched. A search-result snippet may corroborate an
  // official domain only when it explicitly displays that domain.
  for (const result of linkedinResults) {
    for (const mentionedDomain of extractDomainMentions(result.text)) {
      addCandidate(candidates, mentionedDomain, { type: "linkedin-search-snippet", score: 25, url: result.url });
    }
  }
  return linkedinResults;
}

// Fetches and identity-checks the current top-3 scored candidates, skipping
// any domain already attempted in an earlier round (`attempted`) so a
// second search round never re-fetches (and double-scores) the same site.
async function verifyTopCandidates(candidates, company, attempted) {
  const top = [...candidates.values()]
    .filter((candidate) => !attempted.has(candidate.domain))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  for (const candidate of top) {
    attempted.add(candidate.domain);
    try {
      const page = await fetchPage(`https://${candidate.domain}`);
      // Kept even when the identity check below fails — this is the page a
      // best-effort fallback can still summarize from later instead of
      // throwing away a fetch we already paid for. `verifiedSite` (below)
      // stays strictly gated on the identity match; this is not treated as
      // confirmed on its own.
      candidate.fetchedSite = page;
      const identityText = [
        page.title, page.siteName, page.description,
        ...page.organizations.flatMap((organization) => [organization.name, organization.description]),
      ].filter(Boolean).join(" ");

      if (companyMatches(identityText, company)) {
        candidate.score += 35;
        candidate.evidence.push({ type: "official-site-identity", score: 35, url: page.url });
        candidate.sourceUrls.add(page.url);
        candidate.verifiedSite = page;
      }
    } catch {
      // A site may block automated requests. It simply cannot be accepted on
      // site evidence alone in that case.
    }
  }
}

function pickVerifiedWinner(candidates) {
  const winner = [...candidates.values()].sort((a, b) => b.score - a.score)[0];
  const evidenceTypes = new Set(winner?.evidence.map((evidence) => evidence.type) || []);
  const verified = Boolean(
    winner?.verifiedSite &&
    winner.score >= 75 &&
    evidenceTypes.size >= 2 &&
    evidenceTypes.has("official-site-identity")
  );
  return { winner, verified };
}

async function resolveCompany({ company, position, fromHeader, body, html }) {
  const candidates = new Map();
  const senderDomain = extractSenderDomain(fromHeader);
  if (senderDomain) addCandidate(candidates, senderDomain, { type: "corporate-email-sender", score: 45 });
  addDomainsFromEmail(candidates, body, html);

  // A company already resolved before doesn't need to spend Tavily search
  // quota again — but a name-text match alone isn't enough to trust the
  // cache: two unrelated real companies can share a generic name (e.g. two
  // different companies both called "Sela"), and a text match against the
  // cached domain's homepage would false-positive on either one. Only
  // short-circuit when THIS email independently corroborates the cached
  // domain (sender domain or a link in the email body pointing at it) —
  // otherwise fall through to the full Tavily-backed resolution below,
  // which re-derives the domain from this email's own evidence.
  const cached = getCachedCompanyIdentity(company);
  if (cached?.verified && cached.domain && candidates.has(rootDomain(cached.domain))) {
    try {
      const page = await fetchPage(`https://${cached.domain}`);
      const identityText = [
        page.title, page.siteName, page.description,
        ...page.organizations.flatMap((organization) => [organization.name, organization.description]),
      ].filter(Boolean).join(" ");
      if (companyMatches(identityText, company)) {
        return {
          verified: true,
          domain: cached.domain,
          score: cached.score,
          homepage: page,
          sourceUrls: cached.sourceUrls || [],
          linkedinUrl: cached.linkedinUrl || null,
        };
      }
      console.log(`[company-resolve] cached domain for "${company}" no longer matches, re-resolving via Tavily`);
    } catch {
      console.log(`[company-resolve] cached domain for "${company}" unreachable, re-resolving via Tavily`);
    }
  }

  // A company that failed verification recently is also worth remembering
  // — see UNVERIFIED_TTL_MS in companyIdentityCache.js for why this matters
  // more than it might look like it should. No independent corroboration is
  // required to reuse this (unlike the verified-cache path above): the
  // output stays honestly labeled "Unverified matching information" either
  // way, so an occasional company-name collision here costs far less than
  // the alternative of burning a full search round on every single email.
  if (cached && !cached.verified) {
    // Even "found absolutely nothing" is worth remembering for the same
    // short window — a company name that returned zero usable candidates
    // once is very unlikely to return different results minutes or hours
    // later, so this skips a doomed search round entirely rather than just
    // skimping on the page re-fetch below.
    if (!cached.fallbackDomain) {
      return { verified: false, domain: null, score: 0, homepage: null, sourceUrls: [], linkedinUrl: null, fallbackDomain: null, fallbackHomepage: null };
    }
    try {
      const page = await fetchPage(`https://${cached.fallbackDomain}`);
      return {
        verified: false, domain: null, score: cached.score || 0, homepage: null, sourceUrls: [],
        linkedinUrl: cached.linkedinUrl || null, fallbackDomain: cached.fallbackDomain, fallbackHomepage: page,
      };
    } catch {
      return {
        verified: false, domain: null, score: 0, homepage: null, sourceUrls: [],
        linkedinUrl: cached.linkedinUrl || null, fallbackDomain: null, fallbackHomepage: null,
      };
    }
  }

  const primaryQueries = [`"${company}" official website`];
  if (position && !/not specified/i.test(position)) primaryQueries.push(`"${company}" "${position}"`);
  primaryQueries.push(`site:linkedin.com/company "${company}"`);

  const allLinkedinResults = await searchAndScoreCandidates(candidates, primaryQueries, company);
  const attempted = new Set();
  await verifyTopCandidates(candidates, company, attempted);
  let { winner, verified } = pickVerifiedWinner(candidates);

  // A single round of Tavily queries sometimes isn't enough for smaller or
  // ambiguous company names. Before giving up, retry with broader phrasings
  // that tend to surface a careers or LinkedIn-about page even when
  // "official website" doesn't — only spent when the first pass failed, so
  // well-known companies never pay for the extra Tavily calls.
  if (!verified) {
    const broaderQueries = [
      `"${company}" careers`,
      `"${company}" company profile`,
      `"${company}" linkedin about`,
    ];
    const moreLinkedinResults = await searchAndScoreCandidates(candidates, broaderQueries, company);
    allLinkedinResults.push(...moreLinkedinResults);
    await verifyTopCandidates(candidates, company, attempted);
    ({ winner, verified } = pickVerifiedWinner(candidates));
  }

  const result = {
    verified,
    domain: verified ? winner.domain : null,
    score: winner ? Math.min(100, winner.score) : 0,
    homepage: verified ? winner.verifiedSite : null,
    sourceUrls: verified ? [...winner.sourceUrls] : [],
    linkedinUrl: allLinkedinResults[0]?.url || null,
    // Exposed even when verification failed, so a caller can still show a
    // best-effort answer instead of a blank dead end — the top-scored
    // candidate's page, fetched above, just didn't clear the strict
    // identity-match bar. Never treated as confirmed fact; only ever
    // surfaced honestly labeled as unverified.
    fallbackDomain: winner?.domain || null,
    fallbackHomepage: winner?.fetchedSite || null,
  };

  if (result.verified) {
    setCachedCompanyIdentity(company, {
      verified: true,
      domain: result.domain,
      score: result.score,
      sourceUrls: result.sourceUrls,
      linkedinUrl: result.linkedinUrl,
    });
  } else {
    // Cached too — even a "nothing found at all" outcome — just under
    // UNVERIFIED_TTL_MS's much shorter window. See the cache-reuse block
    // above for why this is worth doing at all.
    setCachedCompanyIdentity(company, {
      verified: false,
      score: result.score,
      linkedinUrl: result.linkedinUrl,
      fallbackDomain: result.fallbackDomain,
    });
  }

  return result;
}

function pageEvidence(page) {
  const organizationText = page.organizations
    .map((organization) => [organization.name, organization.description, organization.address].filter(Boolean).join(" — "))
    .filter(Boolean)
    .join("\n");
  return [
    `URL: ${page.url}`,
    page.title && `Title: ${page.title}`,
    page.siteName && `Site name: ${page.siteName}`,
    page.description && `Meta description: ${page.description}`,
    organizationText && `Organization metadata: ${organizationText}`,
    page.body && `Visible page text: ${page.body}`,
  ].filter(Boolean).join("\n");
}

async function collectOfficialEvidence(homepage, domain) {
  const pages = [homepage];
  const links = extractInternalLinks(homepage.html, homepage.url, domain);
  for (const link of links) {
    try {
      const page = await fetchPage(link.url);
      pages.push(page);
    } catch {
      // Continue with the verified homepage if one linked page is unavailable.
    }
  }
  return {
    sources: [...new Set(pages.map((page) => page.url))],
    text: pages.map(pageEvidence).join("\n\n--- OFFICIAL PAGE ---\n\n").slice(0, 8500),
  };
}

// True last resort: no candidate domain was even found to attempt a
// best-effort summary from. Confidence stays 0 so this is never mistaken
// for a real answer, and so a later re-research attempt (e.g. the
// dashboard's "Refresh company info") is still free to try again.
function unverifiedSnapshot(company) {
  return {
    employees: "Not publicly disclosed",
    industry: "Not verified",
    hq: "Unknown",
    publicPrivate: "Unknown",
    whatTheyDo: `Unverified matching information: no public information could be found for "${company}".`,
    sources: [],
    confidence: 0,
  };
}

async function summarizeVerifiedCompany({ company, position, domain, evidenceText, sources, linkedinUrl, confidence }) {
  const prompt = `You are preparing a concise company snapshot for a job seeker who applied for "${position}" at "${company}".

The official domain has been verified as ${domain}. Below is evidence gathered only from that official domain. Do not use general model knowledge. Do not infer facts that are absent from the evidence.

${evidenceText}

Return ONLY valid JSON in this exact shape:
{
  "employees": "employee count/range stated in the evidence, or 'Not publicly disclosed'",
  "industry": "specific industry stated or clearly supported by the evidence, or 'Not verified'",
  "hq": "headquarters city/country stated in the evidence, or 'Unknown'",
  "publicPrivate": "public/private status only if stated in the evidence, otherwise 'Unknown'",
  "whatTheyDo": "one or two concise sentences describing the company’s actual products, services, or business based only on the evidence"
}

Ignore navigation menus, cookie text, recruitment pitches, promotions, isolated news headlines, and unrelated product offers. If the evidence does not genuinely explain what the company does, say "Not verified" rather than writing a plausible description.`;

  // llama-3.3-70b-versatile was deprecated by Groq (announced June 2026),
  // replaced with qwen/qwen3.6-27b — which Groq itself then deprecated
  // (email received 2026-09-01, decommissioned 2026-09-14) in favor of
  // qwen/qwen3.8-27b.
  const summary = await askGroqForJson(prompt, "qwen/qwen3.8-27b");
  return {
    employees: summary.employees || "Not publicly disclosed",
    industry: summary.industry || "Not verified",
    hq: summary.hq || "Unknown",
    publicPrivate: summary.publicPrivate || "Unknown",
    whatTheyDo: summary.whatTheyDo || "Not verified",
    sources: [...new Set([...sources, ...(linkedinUrl ? [linkedinUrl] : [])])],
    confidence,
  };
}

export async function researchCompanyFromEvidence({ company, position, fromHeader, body = "", html = "" }) {
  const identity = await resolveCompany({ company, position, fromHeader, body, html });

  if (identity.verified) {
    const officialEvidence = await collectOfficialEvidence(identity.homepage, identity.domain);
    return summarizeVerifiedCompany({
      company,
      position,
      domain: `https://${identity.domain}`,
      evidenceText: officialEvidence.text,
      sources: officialEvidence.sources,
      linkedinUrl: identity.linkedinUrl,
      confidence: identity.score,
    });
  }

  // Not confidently verified — rather than a blank "not found" dead end,
  // summarize whatever the top-scored (but unconfirmed) candidate's own
  // page actually said, and say so plainly. Confidence is forced to 0
  // regardless of the raw candidate score, so this can never be mistaken
  // for a verified result downstream (see isAlreadyVerified in store.js) —
  // a later refresh is still free to try to actually verify it.
  if (identity.fallbackHomepage) {
    try {
      const summary = await summarizeVerifiedCompany({
        company,
        position,
        domain: `https://${identity.fallbackDomain}`,
        evidenceText: pageEvidence(identity.fallbackHomepage),
        sources: [identity.fallbackHomepage.url],
        linkedinUrl: identity.linkedinUrl,
        confidence: 0,
      });
      return { ...summary, whatTheyDo: `Unverified matching information: ${summary.whatTheyDo}`, confidence: 0 };
    } catch {
      // The fallback candidate's page couldn't be summarized either —
      // fall through to the plain "nothing found" snapshot below.
    }
  }

  return unverifiedSnapshot(company);
}
