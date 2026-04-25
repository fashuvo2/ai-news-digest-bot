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

// 72 hours expressed in seconds (Redis EX TTL is in seconds).
const TTL_SECONDS = 72 * 60 * 60;

// Keep articles available for 13 h (slightly longer than the 12 h digest window).
const ARTICLES_TTL = 13 * 60 * 60;

/**
 * Build the Redis key for a given article URL and namespace.
 * @param {string} url
 * @param {string} ns - namespace, e.g. "ai" or "tech"
 * @returns {string}
 */
function toKey(url, ns) {
  return `digest:seen:${ns}:${url}`;
}

/**
 * Given a list of article URLs, return only the ones not yet seen.
 *
 * @param {string[]} urls
 * @param {string} [ns="ai"] - namespace to scope the deduplication keys
 * @returns {Promise<string[]>} Unseen URLs
 */
async function filterUnseen(urls, ns = "ai") {
  const results = await Promise.allSettled(
    urls.map((url) => redis.get(toKey(url, ns)))
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
 * @param {string} [ns="ai"] - namespace to scope the deduplication keys
 * @returns {Promise<void>}
 */
async function markSeen(urls, ns = "ai") {
  if (urls.length === 0) return;

  await Promise.allSettled(
    urls.map((url) => redis.set(toKey(url, ns), "1", { ex: TTL_SECONDS }))
  );

  console.log(`[storage] Marked ${urls.length} URL(s) as seen in "${ns}" namespace (TTL: ${TTL_SECONDS}s)`);
}

// ── Article store ──────────────────────────────────────────────────────────────
// Persists the last digest's article list so users can request deep dives.

/**
 * Save the articles from the latest digest run so they can be retrieved
 * by index number (1-based) when the user requests a deep dive.
 *
 * @param {Array} articles - Full article objects from fetchFeeds
 * @param {string} [ns="ai"] - namespace to scope the articles key
 * @returns {Promise<void>}
 */
async function saveArticles(articles, ns = "ai") {
  const slim = articles.map((a, i) => ({
    index: i + 1,
    title: a.title || "",
    url: a.link || a.url || "",
    sourceName: a.sourceName || "",
    snippet: (a.contentSnippet || a.summary || "").replace(/<[^>]*>/g, "").slice(0, 500),
    isoDate: a.isoDate || a.pubDate || "",
  }));

  const key = `digest:last_articles:${ns}`;
  await redis.set(key, JSON.stringify(slim), { ex: ARTICLES_TTL });
  console.log(`[storage] Saved ${slim.length} article(s) for deep-dive lookups (namespace: "${ns}")`);
}

/**
 * Retrieve all articles saved from the last digest run.
 *
 * @param {string} [ns="ai"] - namespace to scope the articles key
 * @returns {Promise<Array>} Array of article objects, or empty array if none
 */
async function getAllArticles(ns = "ai") {
  const raw = await redis.get(`digest:last_articles:${ns}`);
  if (!raw) return [];
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * Retrieve a single article by its 1-based digest index.
 *
 * @param {number} index - 1-based article number
 * @param {string} [ns="ai"] - namespace to scope the articles key
 * @returns {Promise<object|null>} Article object or null if not found
 */
async function getArticle(index, ns = "ai") {
  const raw = await redis.get(`digest:last_articles:${ns}`);
  if (!raw) return null;
  const articles = typeof raw === "string" ? JSON.parse(raw) : raw;
  return articles.find((a) => a.index === index) || null;
}

/**
 * Return the total number of articles saved from the last digest.
 *
 * @param {string} [ns="ai"] - namespace to scope the articles key
 * @returns {Promise<number>}
 */
async function getArticleCount(ns = "ai") {
  const raw = await redis.get(`digest:last_articles:${ns}`);
  if (!raw) return 0;
  const articles = typeof raw === "string" ? JSON.parse(raw) : raw;
  return articles.length;
}

// ── Webhook deduplication ──────────────────────────────────────────────────────
// Prevents re-processing Telegram updates that arrive multiple times (retries).

/**
 * Atomically mark a Telegram update_id as seen.
 * Uses SET NX so the key is only written if it doesn't already exist.
 *
 * @param {number|string} updateId - Telegram update_id
 * @returns {Promise<boolean>} true if this is the first time seeing this update (should process),
 *                             false if already seen (should skip)
 */
async function markUpdateSeen(updateId) {
  // 24-hour TTL — longer than Telegram's retry window.
  const result = await redis.set(`digest:webhook_update:${updateId}`, "1", {
    ex: 86400,
    nx: true,
  });
  return result !== null; // "OK" = newly set (process); null = already existed (skip)
}

// ── Batch queue ────────────────────────────────────────────────────────────────
// Supports multi-call batch processing for high-volume pipelines.
// Queue expires after 4 hours to prevent stale state if a run fails.

const QUEUE_TTL = 4 * 60 * 60;

/**
 * Read the current queue state from Redis.
 * Returns null if no queue exists.
 *
 * @param {string} [ns="ai"]
 * @returns {Promise<{ articles: Array, meta: object }|null>}
 */
async function getQueue(ns = "ai") {
  const [rawQueue, rawMeta] = await Promise.all([
    redis.get(`digest:queue:${ns}`),
    redis.get(`digest:queue_meta:${ns}`),
  ]);
  if (!rawQueue) return null;
  return {
    articles: typeof rawQueue === "string" ? JSON.parse(rawQueue) : rawQueue,
    meta: rawMeta ? (typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta) : {},
  };
}

/**
 * Persist the remaining articles in the queue.
 * Deletes the key when the array is empty.
 *
 * @param {Array} articles
 * @param {string} [ns="ai"]
 */
async function setQueue(articles, ns = "ai") {
  if (articles.length === 0) {
    await redis.del(`digest:queue:${ns}`);
  } else {
    await redis.set(`digest:queue:${ns}`, JSON.stringify(articles), { ex: QUEUE_TTL });
  }
}

/**
 * Persist queue metadata (nextIndex, cumulative tokens, promoNote).
 *
 * @param {object} meta
 * @param {string} [ns="ai"]
 */
async function setQueueMeta(meta, ns = "ai") {
  await redis.set(`digest:queue_meta:${ns}`, JSON.stringify(meta), { ex: QUEUE_TTL });
}

/**
 * Delete queue metadata once the run is complete.
 *
 * @param {string} [ns="ai"]
 */
async function clearQueueMeta(ns = "ai") {
  await redis.del(`digest:queue_meta:${ns}`);
}

// ── Seen-key reset ────────────────────────────────────────────────────────────

/**
 * Delete all seen-URL deduplication keys for a namespace using SCAN.
 * Returns the number of keys deleted.
 *
 * @param {string} ns - "ai" or "tech"
 * @returns {Promise<number>}
 */
async function resetSeen(ns) {
  let cursor = 0;
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: `digest:seen:${ns}:*`,
      count: 100,
    });
    cursor = Number(nextCursor);
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== 0);
  console.log(`[storage] Reset ${deleted} seen-key(s) for namespace "${ns}"`);
  return deleted;
}

// ── Kill switch ────────────────────────────────────────────────────────────────
// A single Redis key that, when set, prevents all pipelines from running.
// No TTL — persists until explicitly cleared via clearKillSwitch().

const KILL_SWITCH_KEY = "digest:kill_switch";

/**
 * Returns true if the kill switch is currently active.
 * @returns {Promise<boolean>}
 */
async function getKillSwitch() {
  const val = await redis.get(KILL_SWITCH_KEY);
  return val !== null;
}

/**
 * Activate the kill switch. No TTL — stays until clearKillSwitch() is called.
 * @returns {Promise<void>}
 */
async function setKillSwitch() {
  await redis.set(KILL_SWITCH_KEY, "1");
  console.log("[storage] Kill switch activated.");
}

/**
 * Deactivate the kill switch.
 * @returns {Promise<void>}
 */
async function clearKillSwitch() {
  await redis.del(KILL_SWITCH_KEY);
  console.log("[storage] Kill switch cleared.");
}

/**
 * Delete both queue keys for a namespace, stopping any in-progress batched run.
 * @param {string} [ns="tech"]
 * @returns {Promise<void>}
 */
async function clearQueue(ns = "tech") {
  await Promise.all([
    redis.del(`digest:queue:${ns}`),
    redis.del(`digest:queue_meta:${ns}`),
  ]);
  console.log(`[storage] Queue cleared for namespace "${ns}".`);
}

module.exports = {
  filterUnseen, markSeen, saveArticles, getAllArticles, getArticle, getArticleCount,
  markUpdateSeen,
  getQueue, setQueue, setQueueMeta, clearQueueMeta,
  resetSeen,
  getKillSwitch, setKillSwitch, clearKillSwitch, clearQueue,
};
