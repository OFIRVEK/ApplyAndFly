import dns from "dns";
import net from "net";

// SSRF guard shared by every code path that fetches a URL derived from
// email content (sender domain, links in the body/HTML) — attacker
// -controllable input. Without this, a crafted email pointing "our website"
// at e.g. 169.254.169.254 (a cloud metadata endpoint) or localhost would
// make THIS SERVER fetch it. Blocks private/loopback/link-local/reserved
// ranges for both IPv4 and IPv6, checked against every resolved address
// (a hostname can resolve to more than one, so all must be public).
// Extracted from companyEvidence.js so enrich.js's website-blurb fetcher —
// which previously had NO such protection despite fetching the same kind of
// email-derived domains — uses the identical checks.
const PRIVATE_IPV4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPrivateIpv4(ip) {
  const intIp = ipv4ToInt(ip);
  if (intIp === null) return true; // malformed — treat as unsafe rather than guess
  return PRIVATE_IPV4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (intIp & mask) === (ipv4ToInt(base) & mask);
  });
}

export function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export async function assertPublicHostname(hostname) {
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.promises.lookup(hostname, { all: true });

  for (const { address, family } of addresses) {
    const isPrivate = family === 6 ? isPrivateIpv6(address) : isPrivateIpv4(address);
    if (isPrivate) {
      throw new Error(`refusing to fetch private/reserved address ${address} for host "${hostname}"`);
    }
  }
}

// Shared fetch limits for external, untrusted web pages: a page big enough
// to blow past this cap has no useful "what does this company do" text in
// its first megabytes anyway, and without a cap a malicious site could feed
// an unbounded response. Content-type is checked because only text is ever
// parsed — a binary (PDF, zip, video) would just be garbage input.
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export function isTextContentType(contentType = "") {
  return /^(text\/|application\/(xhtml\+)?xml)/i.test(String(contentType).trim());
}
