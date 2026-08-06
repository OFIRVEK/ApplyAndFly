import axios from "axios";
import { config } from "./config.js";

// Tavily's REST API — plain HTTPS, no MCP host needed. Real-time web search
// used by the Company Resolution Engine for company/website discovery and
// LinkedIn company-page discovery (search only, never scraped).
export async function tavilySearch(query, { maxResults = 5, searchDepth = "basic" } = {}) {
  if (!config.tavily.apiKey) {
    console.log(`[tavily] no TAVILY_API_KEY configured, skipping search: "${query}"`);
    return [];
  }

  try {
    const res = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: config.tavily.apiKey,
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: false,
      },
      { timeout: 8000 }
    );
    return res.data?.results || [];
  } catch (err) {
    // Do not log the complete Axios error object: it may include the request
    // body and therefore the API key when a network call fails.
    console.error(`[tavily] search failed for "${query}":`, err.response?.status || err.code || err.message || "unknown error");
    return [];
  }
}
