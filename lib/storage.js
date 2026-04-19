/**
 * storage.js
 * Thin wrapper around Vercel KV (backed by Upstash Redis) for tracking
 * which article URLs have already been processed.
 *
 * Each URL is stored as a key with a 72-hour TTL so the set of "seen"
 * URLs automatically shrinks over time and KV storage stays minimal.
 */

const { kv } = require("@vercel/kv");

// Prefix every key so the KV store stays organised if it's shared.
const KEY_PREFIX = "digest:seen:";

// 72 hours expressed in seconds (KV TTL is in seconds).
const TTL_SECONDS = 72 * 60 * 60;

/**
 * Build the KV key for a given article URL.
 *
 * @param {string} url
 * @returns {string}
 */
function toKey(url) {
  // Use the URL directly as the key suffix — it's already a unique identifier.
  return KEY_PREFIX + url;
}

/**
 * Check whether a single URL has already been processed.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function isSeen(url) {
  const value = await kv.get(toKey(url));
  return value !== null;
}

/**
 * Given a list of article URLs, return only the ones that have NOT yet
 * been seen (i.e. not stored in KV).
 *
 * Uses Promise.allSettled so a single KV hiccup doesn't drop all URLs.
 *
 * @param {string[]} urls
 * @returns {Promise<string[]>} Unseen URLs
 */
async function filterUnseen(urls) {
  const results = await Promise.allSettled(urls.map((url) => isSeen(url)));

  return urls.filter((_, idx) => {
    const result = results[idx];
    // Treat errors as "not seen" so we don't silently skip articles.
    if (result.status === "rejected") {
      console.warn(`[storage] KV check failed for URL at index ${idx} — treating as unseen`);
      return true;
    }
    return result.value === false; // keep URLs that are NOT yet seen
  });
}

/**
 * Mark a list of URLs as seen by storing them in KV with a 72-hour TTL.
 *
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
async function markSeen(urls) {
  if (urls.length === 0) return;

  // Fire all writes in parallel for efficiency.
  await Promise.allSettled(
    urls.map((url) =>
      kv.set(toKey(url), "1", { ex: TTL_SECONDS })
    )
  );

  console.log(`[storage] Marked ${urls.length} URL(s) as seen (TTL: ${TTL_SECONDS}s)`);
}

module.exports = { filterUnseen, markSeen };
