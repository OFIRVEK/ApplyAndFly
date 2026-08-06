import axios from "axios";
import { config } from "./config.js";

// Firecrawl's REST API — plain HTTPS, no MCP host needed. Only ever called
// against an already-verified official website (never an unverified guess),
// per the Company Resolution Engine's crawl stage.
export async function firecrawlScrape(url) {
  if (!config.firecrawl.apiKey) {
    console.log(`[firecrawl] no FIRECRAWL_API_KEY configured, skipping scrape: ${url}`);
    return null;
  }

  try {
    const res = await axios.post(
      "https://api.firecrawl.dev/v1/scrape",
      { url, formats: ["markdown"], onlyMainContent: true },
      {
        headers: {
          Authorization: `Bearer ${config.firecrawl.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    return res.data?.data?.markdown || null;
  } catch (err) {
    console.error(`[firecrawl] scrape failed for ${url}:`, err.response?.data || err.message || err);
    return null;
  }
}
