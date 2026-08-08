import axios from "axios";
import { askGroqForJson, extractSenderDomain, isAtsOrGenericDomain } from "./enrich.js";
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

async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: 8000,
    maxRedirects: 4,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ApplyAndFly/1.0; company research)" },
    responseType: "text",
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const html = typeof response.data === "string" ? response.data : "";
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const description = metaContent(html, ["description", "og:description", "twitter:description"]);
  const siteName = metaContent(html, ["og:site_name", "application-name"]);
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || response.request?.res?.responseUrl || url;
  const organizations = extractOrganizations(html);
  const body = cleanText(html).slice(0, 2600);

  return { url: canonical, html, title, description, siteName, organizations, body };
}

function addCandidate(candidates, domain, evidence) {
  const host = domain?.toLowerCase().replace(/^www\./, "");
  if (isBlockedHost(host)) return;
  const root = rootDomain(host);
  const existing = candidates.get(root) || { domain: root, score: 0, evidence: [], sourceUrls: new Set(), verifiedSite: null };
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

async function resolveCompany({ company, position, fromHeader, body, html }) {
  const candidates = new Map();
  const senderDomain = extractSenderDomain(fromHeader);
  if (senderDomain) addCandidate(candidates, senderDomain, { type: "corporate-email-sender", score: 45 });
  addDomainsFromEmail(candidates, body, html);

  // A company already resolved before doesn't need to spend Tavily search
  // quota again — re-verify the cached domain still identifies as this
  // company (a direct fetch, no Tavily cost) and reuse it if so. Falls
  // through to the full Tavily-backed resolution below if the cached domain
  // has gone stale or unreachable.
  const cached = getCachedCompanyIdentity(company);
  if (cached?.verified && cached.domain) {
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

  const queries = [`"${company}" official website`];
  if (position && !/not specified/i.test(position)) queries.push(`"${company}" "${position}"`);
  queries.push(`site:linkedin.com/company "${company}"`);

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

  const initial = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 3);
  for (const candidate of initial) {
    try {
      const page = await fetchPage(`https://${candidate.domain}`);
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

  const winner = [...candidates.values()].sort((a, b) => b.score - a.score)[0];
  const evidenceTypes = new Set(winner?.evidence.map((evidence) => evidence.type) || []);
  const verified = Boolean(
    winner?.verifiedSite &&
    winner.score >= 75 &&
    evidenceTypes.size >= 2 &&
    evidenceTypes.has("official-site-identity")
  );

  const result = {
    verified,
    domain: verified ? winner.domain : null,
    score: winner ? Math.min(100, winner.score) : 0,
    homepage: verified ? winner.verifiedSite : null,
    sourceUrls: verified ? [...winner.sourceUrls] : [],
    linkedinUrl: linkedinResults[0]?.url || null,
  };

  if (result.verified) {
    setCachedCompanyIdentity(company, {
      verified: true,
      domain: result.domain,
      score: result.score,
      sourceUrls: result.sourceUrls,
      linkedinUrl: result.linkedinUrl,
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

function unverifiedSnapshot(company) {
  return {
    employees: "Not publicly disclosed",
    industry: "Not verified",
    hq: "Unknown",
    publicPrivate: "Unknown",
    whatTheyDo: `Company identity for "${company}" could not be confidently verified from the application email and public sources.`,
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

  const summary = await askGroqForJson(prompt, "llama-3.3-70b-versatile");
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
  if (!identity.verified) return unverifiedSnapshot(company);

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
