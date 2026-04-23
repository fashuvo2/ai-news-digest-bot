/**
 * /app/api/reset/route.js
 *
 * Clears the "seen" deduplication keys in Redis so the next digest run
 * will treat recently published articles as new.
 *
 * POST /api/reset
 *   Body (optional JSON): { "ns": "ai" | "tech" }
 *   Omit "ns" to reset both namespaces.
 *
 * Protected by the same CRON_SECRET as the digest endpoints.
 */

import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function isAuthorised(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Delete all keys matching a pattern by iterating with SCAN.
 * Returns the number of keys deleted.
 *
 * @param {string} pattern - e.g. "digest:seen:ai:*"
 * @returns {Promise<number>}
 */
async function deleteByPattern(pattern) {
  let cursor = 0;
  let deleted = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: pattern,
      count: 100,
    });
    cursor = Number(nextCursor);

    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== 0);

  return deleted;
}

export async function POST(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let ns = null;
  try {
    const body = await request.json().catch(() => ({}));
    if (body.ns === "ai" || body.ns === "tech") ns = body.ns;
  } catch {
    // no body — reset both namespaces
  }

  const namespaces = ns ? [ns] : ["ai", "tech"];
  const results = {};

  for (const namespace of namespaces) {
    const count = await deleteByPattern(`digest:seen:${namespace}:*`);
    results[namespace] = count;
    console.log(`[reset] Deleted ${count} seen-key(s) for namespace "${namespace}"`);
  }

  return NextResponse.json({ status: "ok", deleted: results });
}
