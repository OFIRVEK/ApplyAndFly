import axios from "axios";
import { config } from "./config.js";

// Serper.dev's REST API — a thin wrapper around real Google search results.
// Replaces Tavily as the web-search evidence source for the Company
// Resolution Engine (company/website discovery and LinkedIn company-page
// discovery, search only, never scraped). Same {url, title, content} shape
// as the old tavilySearch() so companyEvidence.js needed no changes beyond
// the import.
export async function serperSearch(query, { maxResults = 5 } = {}) {
  if (!config.serper.apiKey) {
    console.log(`[serper] no SERPER_API_KEY configured, skipping search: "${query}"`);
    return [];
  }

  try {
    const res = await axios.post(
      "https://google.serper.dev/search",
      { q: query, num: maxResults },
      {
        headers: {
          "X-API-KEY": config.serper.apiKey,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      }
    );

    const organic = res.data?.organic || [];
    return organic.slice(0, maxResults).map((result) => ({
      url: result.link,
      title: result.title,
      content: result.snippet,
    }));
  } catch (err) {
    // Do not log the complete Axios error object: it may include the request
    // headers and therefore the API key when a network call fails.
    console.error(`[serper] search failed for "${query}":`, err.response?.status || err.code || err.message || "unknown error");
    return [];
  }
}
