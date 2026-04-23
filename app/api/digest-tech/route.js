/**
 * /app/api/digest-tech/route.js
 *
 * Tech news digest endpoint — stateful batch processing.
 *
 * Because Vercel's Free plan limits functions to 60 seconds, this endpoint
 * processes articles in small batches across multiple calls. GitHub Actions
 * loops until the queue is drained.
 *
 * First call:
 *   1. Validate auth.
 *   2. Fetch RSS feeds, deduplicate, filter promos.
 *   3. Save all articles to Redis for deep-dive lookups (correct 1-based indices).
 *   4. Mark all URLs as seen.
 *   5. Store remaining articles as a queue in Redis.
 *   6. Process the first batch → Telegram.
 *   7. Return { status: "batching" } or { status: "complete" } if ≤ BATCH_SIZE articles.
 *
 * Subsequent calls:
 *   1. Validate auth.
 *   2. Pop next batch from Redis queue.
 *   3. Process → Telegram.
 *   4. Return { status: "batching" } or { status: "complete" }.
 */

import { NextResponse } from "next/server";
import { fetchRecentArticles, filterPromoArticles } from "@/lib/fetchFeeds";
import { summarizeArticles } from "@/lib/summarize";
import { sendMessage } from "@/lib/telegram";
import {
  filterUnseen, markSeen, saveArticles,
  getQueue, setQueue, setQueueMeta, clearQueueMeta,
} from "@/lib/storage";
import TECH_SOURCES from "@/lib/sources-tech";

// Allow up to 60 seconds (Vercel Free plan maximum).
export const maxDuration = 60;

// Articles per batch — keeps each invocation well within the 60 s limit.
const BATCH_SIZE = 10;

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
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  console.log("[digest-tech] Batch call received…");

  try {
    let queue = await getQueue("tech");

    // ── First call: fetch articles and initialise queue ──────────────────────
    if (!queue) {
      console.log("[digest-tech] No queue found — fetching articles…");

      const recentArticles = await fetchRecentArticles(12, TECH_SOURCES);
      const recentUrls = recentArticles.map((a) => a.link || a.url).filter(Boolean);
      const newUrls = await filterUnseen(recentUrls, "tech");
      const unseenArticles = recentArticles.filter((a) =>
        newUrls.includes(a.link || a.url)
      );
      const { kept: newArticles, totalExcluded, excludedReasons } =
        filterPromoArticles(unseenArticles);

      console.log(
        `[digest-tech] ${recentArticles.length} fetched; ` +
          `${unseenArticles.length} new; ${totalExcluded} promo excluded`
      );

      if (newArticles.length === 0) {
        await sendMessage("কোনো নতুন প্রযুক্তি খবর নেই।");
        return NextResponse.json({ status: "no_new_articles" });
      }

      const promoNote =
        totalExcluded > 0
          ? `🚫 ${totalExcluded}টি প্রমো আর্টিকেল বাদ দেওয়া হয়েছে — ` +
            Object.entries(excludedReasons)
              .map(([kw, n]) => `${kw} (${n})`)
              .join(", ")
          : "";

      // Save all articles upfront with correct 1-based indices for deep-dive.
      await saveArticles(newArticles, "tech");
      // Mark all URLs seen now so re-runs don't reprocess them.
      await markSeen(newUrls, "tech");

      // Store queue state.
      await setQueue(newArticles, "tech");
      await setQueueMeta(
        {
          nextIndex: 1,
          tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          promoNote,
        },
        "tech"
      );

      queue = {
        articles: newArticles,
        meta: {
          nextIndex: 1,
          tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          promoNote,
        },
      };
    }

    // ── Pop and process the next batch ───────────────────────────────────────
    const { articles, meta } = queue;
    const { nextIndex, tokens, promoNote } = meta;

    const batch = articles.slice(0, BATCH_SIZE);
    const rest = articles.slice(BATCH_SIZE);
    const isLastBatch = rest.length === 0;

    console.log(
      `[digest-tech] Processing articles ${nextIndex}–${nextIndex + batch.length - 1}` +
        ` (${rest.length} remaining after this batch)…`
    );

    const { summary, usage } = await summarizeArticles(batch, "tech", nextIndex);

    const updatedTokens = {
      input_tokens: tokens.input_tokens + usage.input_tokens,
      output_tokens: tokens.output_tokens + usage.output_tokens,
      total_tokens: tokens.total_tokens + usage.total_tokens,
    };

    // Persist updated queue state.
    await setQueue(rest, "tech");

    if (isLastBatch) {
      // Append token footer (and promo note if any) to the final message.
      const footer = [
        promoNote || "",
        `\n📊 টোকেন: ইনপুট ${updatedTokens.input_tokens} · আউটপুট ${updatedTokens.output_tokens} · মোট ${updatedTokens.total_tokens}`,
      ]
        .filter(Boolean)
        .join("\n");
      await sendMessage(summary + (footer ? "\n" + footer : ""));
      await clearQueueMeta("tech");
      console.log("[digest-tech] All batches complete.");
    } else {
      await sendMessage(summary);
      await setQueueMeta(
        { nextIndex: nextIndex + BATCH_SIZE, tokens: updatedTokens, promoNote },
        "tech"
      );
    }

    return NextResponse.json({
      status: isLastBatch ? "complete" : "batching",
      batch_start: nextIndex,
      batch_end: nextIndex + batch.length - 1,
      remaining: rest.length,
      token_usage: updatedTokens,
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
