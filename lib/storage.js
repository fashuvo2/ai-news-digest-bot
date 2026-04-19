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
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
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

module.exports = { filterUnseen, markSeen };
