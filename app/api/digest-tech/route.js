/**
 * /app/api/digest-tech/route.js
 *
 * Tech news digest endpoint. Triggered manually via GitHub Actions.
 *
 * Flow:
 *  1. Validate the Authorization header against CRON_SECRET.
 *  2. Fetch all tech RSS/Atom feeds and keep only articles from the last 12 hours.
 *  3. Filter out URLs already stored in Redis (already processed, "tech" namespace).
 *  4. If nothing new → send a "no news" Telegram message and exit.
 *  5. Send the new articles to Claude → receive Bengali digest + token usage.
 *  6. Save the newly processed URLs to Redis (72-hour TTL, "tech" namespace).
 *  7. Send the digest + token footer to Telegram.
 *  8. Return JSON with status, article count, and token usage.
 */

import { NextResponse } from "next/server";
import { fetchRecentArticles, filterPromoArticles } from "@/lib/fetchFeeds";
import { summarizeBatched } from "@/lib/summarize";
import { sendBatchedDigest, sendMessage } from "@/lib/telegram";
import { filterUnseen, markSeen, saveArticles } from "@/lib/storage";
import TECH_SOURCES from "@/lib/sources-tech";

// Allow up to 300 seconds — tech feeds can be high-volume.
export const maxDuration = 300;

// Cap articles sent to Claude to stay within the time budget (3 batches of 25).
const MAX_ARTICLES = 75;

// ── Security guard ─────────────────────────────────────────────────────────────

function isAuthorised(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[digest-tech] CRON_SECRET is not set — rejecting request");
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

  console.log("[digest-tech] Starting tech digest run…");

  try {
    // Step 2 — Fetch recent articles (last 12 hours) from all tech RSS sources.
    const recentArticles = await fetchRecentArticles(12, TECH_SOURCES);

    // Extract unique URLs for the deduplication check.
    const recentUrls = recentArticles
      .map((a) => a.link || a.url)
      .filter(Boolean);

    // Step 3 — Filter out articles we've already processed ("tech" namespace).
    const newUrls = await filterUnseen(recentUrls, "tech");

    // Build the filtered article list (preserving full metadata for Claude).
    const unseenArticles = recentArticles.filter((a) =>
      newUrls.includes(a.link || a.url)
    );

    // Filter out promotional articles.
    const { kept: keptArticles, totalExcluded, excludedReasons } = filterPromoArticles(unseenArticles);

    // Cap to the most recent MAX_ARTICLES to stay within the time budget.
    const newArticles = keptArticles.slice(0, MAX_ARTICLES);
    const capped = keptArticles.length - newArticles.length;

    console.log(
      `[digest-tech] ${recentArticles.length} recent articles fetched; ` +
        `${unseenArticles.length} are new; ${totalExcluded} excluded as promo` +
        (capped > 0 ? `; ${capped} capped` : "")
    );

    // Step 4 — Nothing new? Send a short "no news" notification and exit.
    if (newArticles.length === 0) {
      await sendMessage("কোনো নতুন প্রযুক্তি খবর নেই।");
      return NextResponse.json({
        status: "no_new_articles",
        message: "No new tech articles found in the last 12 hours.",
      });
    }

    // Step 5 — Summarise with Claude in batches of 25 articles.
    const { summaries, usage } = await summarizeBatched(newArticles, "tech");

    // Step 6 — Persist the newly processed URLs in Redis (72-hour TTL),
    // and save the article list for deep-dive lookups (both under "tech" namespace).
    await markSeen(newUrls, "tech");
    await saveArticles(newArticles, "tech");

    // Step 7 — Send all batch messages to Telegram (token footer on last).
    const promoNote =
      totalExcluded > 0
        ? `🚫 ${totalExcluded}টি প্রমো আর্টিকেল বাদ দেওয়া হয়েছে — ` +
          Object.entries(excludedReasons)
            .map(([kw, n]) => `${kw} (${n})`)
            .join(", ")
        : "";
    await sendBatchedDigest(summaries, usage, promoNote);

    console.log("[digest-tech] Run complete.");

    // Step 8 — Return a success response with run metadata.
    return NextResponse.json({
      status: "ok",
      articles_processed: newArticles.length,
      token_usage: usage,
    });
  } catch (err) {
    console.error("[digest-tech] Unexpected error:", err);
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
