/**
 * fetchFeeds.js
 * Fetches and parses all RSS/Atom feeds in parallel, then filters
 * down to articles published within the last 12 hours.
 */

const Parser = require("rss-parser");
const DEFAULT_SOURCES = require("./sources");

const PROMO_KEYWORDS = ["promo", "promotion", "offer", "% off", "deal", "deals", "coupon"];

// rss-parser instance — customise field mappings here if a feed uses
// non-standard element names (e.g. YouTube Atom uses <media:group>).
const parser = new Parser({
  timeout: 10_000, // 10 s per feed
  customFields: {
    item: [
      ["media:group", "mediaGroup"],
      ["media:description", "mediaDescription"],
    ],
  },
});

/**
 * Fetch a single RSS/Atom feed and return its items.
 * Returns an empty array on error so one bad feed never blocks the rest.
 *
 * @param {{ name: string, url: string }} source
 * @returns {Promise<Array>}
 */
async function fetchSingleFeed(source) {
  try {
    const feed = await parser.parseURL(source.url);
    // Attach the source name to each item so downstream code knows the origin.
    return feed.items.map((item) => ({
      ...item,
      sourceName: source.name,
    }));
  } catch (err) {
    console.error(`[fetchFeeds] Failed to fetch "${source.name}": ${err.message}`);
    return [];
  }
}

/**
 * Fetch all configured feeds in parallel and return only articles
 * published in the last `windowHours` hours (default: 12).
 *
 * @param {number} windowHours - How many hours back to look (default 12)
 * @returns {Promise<Array>} Filtered list of recent articles
 */
async function fetchRecentArticles(windowHours = 12, sources = DEFAULT_SOURCES) {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1_000);

  // Fetch all feeds concurrently — Promise.allSettled so one failure
  // doesn't short-circuit the others.
  const results = await Promise.allSettled(
    sources.map((source) => fetchSingleFeed(source))
  );

  const allItems = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );

  // Filter to items published after the cutoff window.
  const recentItems = allItems.filter((item) => {
    // rss-parser normalises pubDate / isoDate — prefer isoDate if present.
    const rawDate = item.isoDate || item.pubDate;
    if (!rawDate) return false; // skip items with no date
    const published = new Date(rawDate);
    return published >= cutoff;
  });

  console.log(
    `[fetchFeeds] ${allItems.length} total items fetched; ` +
      `${recentItems.length} published in the last ${windowHours}h`
  );

  return recentItems;
}

/**
 * Remove articles whose title or description contains a promotional keyword.
 * Returns the kept articles and a breakdown of what was excluded.
 *
 * @param {Array} articles
 * @returns {{ kept: Array, totalExcluded: number, excludedReasons: Record<string, number> }}
 */
function filterPromoArticles(articles) {
  const kept = [];
  const excludedReasons = {};

  for (const article of articles) {
    const text = [
      article.title || "",
      article.contentSnippet || article.summary || "",
    ]
      .join(" ")
      .toLowerCase();

    const matched = PROMO_KEYWORDS.find((kw) => text.includes(kw));

    if (matched) {
      excludedReasons[matched] = (excludedReasons[matched] || 0) + 1;
      console.log(`[fetchFeeds] Excluded promo article ("${matched}"): ${article.title}`);
    } else {
      kept.push(article);
    }
  }

  const totalExcluded = Object.values(excludedReasons).reduce((a, b) => a + b, 0);
  return { kept, totalExcluded, excludedReasons };
}

module.exports = { fetchRecentArticles, filterPromoArticles };
