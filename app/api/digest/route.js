/**
 * /app/api/digest/route.js
 *
 * Main digest endpoint. Called on a schedule by GitHub Actions.
 *
 * Flow:
 *  1. Validate the Authorization header against CRON_SECRET.
 *  2. Fetch all RSS/Atom feeds and keep only articles from the last 12 hours.
 *  3. Filter out URLs already stored in Vercel KV (already processed).
 *  4. If nothing new → send a "no news" Telegram message and exit.
 *  5. Send the new articles to Claude → receive Bengali digest + token usage.
 *  6. Save the newly processed URLs to KV (72-hour TTL).
 *  7. Send the digest + token footer to Telegram.
 *  8. Return JSON with status, article count, and token usage.
 */

import { NextResponse } from "next/server";
import { fetchRecentArticles } from "@/lib/fetchFeeds";
import { summarizeArticles } from "@/lib/summarize";
import { sendDigest, sendMessage } from "@/lib/telegram";
import { filterUnseen, markSeen } from "@/lib/storage";

// ── Security guard ─────────────────────────────────────────────────────────────

/**
 * Verify that the incoming request carries the correct CRON_SECRET.
 * Returns true if authorised, false otherwise.
 *
 * @param {Request} request
 * @returns {boolean}
 */
function isAuthorised(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If no secret is configured, block all requests for safety.
    console.error("[digest] CRON_SECRET is not set — rejecting request");
    return false;
  }

  const authHeader = request.headers.get("authorization") || "";
  return authHeader === `Bearer ${secret}`;
}

// ── Route handler ──────────────────────────────────────────────────────────────

export async function POST(request) {
  // Step 1 — Authorisation check.
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  console.log("[digest] Starting digest run…");

  try {
    // Step 2 — Fetch recent articles (last 12 hours) from all RSS sources.
    const recentArticles = await fetchRecentArticles(12);

    // Extract unique URLs for the deduplication check.
    const recentUrls = recentArticles
      .map((a) => a.link || a.url)
      .filter(Boolean);

    // Step 3 — Filter out articles we've already processed.
    const newUrls = await filterUnseen(recentUrls);

    // Build the filtered article list (preserving full metadata for Claude).
    const newArticles = recentArticles.filter((a) =>
      newUrls.includes(a.link || a.url)
    );

    console.log(
      `[digest] ${recentArticles.length} recent articles fetched; ` +
        `${newArticles.length} are new (not yet seen)`
    );

    // Step 4 — Nothing new? Send a short "no news" notification and exit.
    if (newArticles.length === 0) {
      await sendMessage("কোনো নতুন খবর নেই।");
      return NextResponse.json({
        status: "no_new_articles",
        message: "No new articles found in the last 12 hours.",
      });
    }

    // Step 5 — Summarise with Claude (returns Bengali text + token usage).
    const { summary, usage } = await summarizeArticles(newArticles);

    // Step 6 — Persist the newly processed URLs in KV (72-hour TTL).
    await markSeen(newUrls);

    // Step 7 — Send the digest (with token footer) to Telegram.
    await sendDigest(summary, usage);

    console.log("[digest] Run complete.");

    // Step 8 — Return a success response with run metadata.
    return NextResponse.json({
      status: "ok",
      articles_processed: newArticles.length,
      token_usage: usage,
    });
  } catch (err) {
    // Log the full error server-side; return a sanitised message to the caller.
    console.error("[digest] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error", detail: err.message },
      { status: 500 }
    );
  }
}

// Reject non-POST methods with a clear error.
export async function GET() {
  return NextResponse.json(
    { error: "Method not allowed. Use POST." },
    { status: 405 }
  );
}
