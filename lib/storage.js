/**
 * storage.js
 * Thin wrapper around Upstash Redis for tracking which article URLs
 * have already been processed.
 *
 * Each URL is stored as a key with a 72-hour TTL so the set of "seen"
 * URLs automatically shrinks over time and Redis storage stays minimal.
 *
 * Uses @upstash/redis directly (reads UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN from the environment — injected automatically
 * when you connect an Upstash Redis integration on Vercel).
 */

const { Redis } = require("@upstash/redis");

// Initialise the Redis client — reads env vars automatically.
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Prefix every key so the store stays organised.
const KEY_PREFIX = "digest:seen:";

// 72 hours expressed in seconds (Redis EX TTL is in seconds).
const TTL_SECONDS = 72 * 60 * 60;

/**
 * Build the Redis key for a given article URL.
 * @param {string} url
 * @returns {string}
 */
function toKey(url) {
  return KEY_PREFIX + url;
}

/**
 * Given a list of article URLs, return only the ones not yet seen.
 *
 * @param {string[]} urls
 * @returns {Promise<string[]>} Unseen URLs
 */
async function filterUnseen(urls) {
  const results = await Promise.allSettled(
    urls.map((url) => redis.get(toKey(url)))
  );

  return urls.filter((_, idx) => {
    const result = results[idx];
    if (result.status === "rejected") {
      console.warn(`[storage] Redis check failed for index ${idx} — treating as unseen`);
      return true;
    }
    return result.value === null; // null means key doesn't exist → not yet seen
  });
}

/**
 * Mark a list of URLs as seen with a 72-hour TTL.
 *
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
async function markSeen(urls) {
  if (urls.length === 0) return;

  await Promise.allSettled(
    urls.map((url) => redis.set(toKey(url), "1", { ex: TTL_SECONDS }))
  );

  console.log(`[storage] Marked ${urls.length} URL(s) as seen (TTL: ${TTL_SECONDS}s)`);
}

// ── Article store ──────────────────────────────────────────────────────────────
// Persists the last digest's article list so users can request deep dives.

const ARTICLES_KEY = "digest:last_articles";
// Keep articles available for 13 h (slightly longer than the 12 h digest window).
const ARTICLES_TTL = 13 * 60 * 60;

/**
 * Save the articles from the latest digest run so they can be retrieved
 * by index number (1-based) when the user requests a deep dive.
 *
 * @param {Array} articles - Full article objects from fetchFeeds
 * @returns {Promise<void>}
 */
async function saveArticles(articles) {
  const slim = articles.map((a, i) => ({
    index: i + 1,
    title: a.title || "",
    url: a.link || a.url || "",
    sourceName: a.sourceName || "",
    snippet: (a.contentSnippet || a.summary || "").replace(/<[^>]*>/g, "").slice(0, 500),
    isoDate: a.isoDate || a.pubDate || "",
  }));

  await redis.set(ARTICLES_KEY, JSON.stringify(slim), { ex: ARTICLES_TTL });
  console.log(`[storage] Saved ${slim.length} article(s) for deep-dive lookups`);
}

/**
 * Retrieve a single article by its 1-based digest index.
 *
 * @param {number} index - 1-based article number
 * @returns {Promise<object|null>} Article object or null if not found
 */
async function getArticle(index) {
  const raw = await redis.get(ARTICLES_KEY);
  if (!raw) return null;
  const articles = typeof raw === "string" ? JSON.parse(raw) : raw;
  return articles.find((a) => a.index === index) || null;
}

/**
 * Return the total number of articles saved from the last digest.
 *
 * @returns {Promise<number>}
 */
async function getArticleCount() {
  const raw = await redis.get(ARTICLES_KEY);
  if (!raw) return 0;
  const articles = typeof raw === "string" ? JSON.parse(raw) : raw;
  return articles.length;
}

module.exports = { filterUnseen, markSeen, saveArticles, getArticle, getArticleCount };
