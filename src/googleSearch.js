import axios from "axios";
import { config } from "./config.js";

// Google's official Programmable Search Engine (Custom Search JSON API) —
// real Google results, same shape of use as Serper/Tavily before it
// (search only, results never scraped). Free for up to 100 queries/day.
// Needs two values from https://programmablesearchengine.google.com/ (a
// search engine configured for "Search the entire web") plus an API key
// from Google Cloud Console with the Custom Search API enabled:
//   GOOGLE_SEARCH_API_KEY, GOOGLE_SEARCH_ENGINE_ID
export async function googleSearch(query, { maxResults = 5 } = {}) {
  if (!config.googleSearch.apiKey || !config.googleSearch.engineId) {
    console.log(`[google-search] no GOOGLE_SEARCH_API_KEY/GOOGLE_SEARCH_ENGINE_ID configured, skipping search: "${query}"`);
    return [];
  }

  try {
    const res = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: {
        key: config.googleSearch.apiKey,
        cx: config.googleSearch.engineId,
        q: query,
        // The API rejects anything above 10 per request.
        num: Math.min(Math.max(maxResults, 1), 10),
      },
      timeout: 8000,
    });

    const items = res.data?.items || [];
    return items.slice(0, maxResults).map((item) => ({
      url: item.link,
      title: item.title,
      content: item.snippet,
    }));
  } catch (err) {
    // Do not log the complete Axios error object: it may include the request
    // URL/params and therefore the API key when a network call fails.
    console.error(`[google-search] search failed for "${query}":`, err.response?.status || err.code || err.message || "unknown error");
    return [];
  }
}
