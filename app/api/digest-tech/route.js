/**
 * /app/api/digest-tech/route.js
 *
 * Tech news digest endpoint — stateful batch processing.
 *
 * Because Vercel's Free plan limits functions to 60 seconds, work is split
 * across multiple calls. GitHub Actions loops until the queue is drained.
 *
 * Call 1 — init only (no Claude):
 *   Fetch RSS, deduplicate, store queue in Redis, send Telegram status, return
 *   { status: "initializing" }.
 *
 * Calls 2..N — one batch per call:
 *   Pop BATCH_SIZE articles from Redis, summarize with Claude, send to Telegram,
 *   return { status: "batching" } or { status: "complete" }.
 */

import { NextResponse } from "next/server";
import { fetchRecentArticles, filterPromoArticles } from "@/lib/fetchFeeds";
import { summarizeArticles } from "@/lib/summarize";
import { sendMessage } from "@/lib/telegram";
import {
  filterUnseen, markSeen, saveArticles, getAllArticles,
  getQueue, setQueue, setQueueMeta, clearQueueMeta,
  getKillSwitch,
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

  // Kill switch check — runs on every call (init + every batch).
  const killed = await getKillSwitch();
  if (killed) {
    console.log("[digest-tech] Kill switch is active — aborting.");
    return NextResponse.json(
      { status: "stopped", reason: "kill switch active" },
      { status: 503 }
    );
  }

  console.log("[digest-tech] Call received…");

  try {
    const queue = await getQueue("tech");

    // ── Call 1: fetch articles, build queue, return immediately ─────────────
    if (!queue) {
      console.log("[digest-tech] No queue — fetching articles…");

      const { articles: recentArticles, skippedFeeds } = await fetchRecentArticles(12, TECH_SOURCES);

      if (skippedFeeds.length > 0) {
        await sendMessage(
          `⚠️ ${skippedFeeds.length}টি ফিড লোড হয়নি (টাইমআউট বা এরর): ${skippedFeeds.join(", ")}`
        );
      }

      const recentUrls = recentArticles.map((a) => a.link || a.url).filter(Boolean);
      const newUrls = await filterUnseen(recentUrls, "tech");
      const unseenArticles = recentArticles.filter((a) =>
        newUrls.includes(a.link || a.url)
      );
      const { kept: newArticles, totalExcluded, excludedReasons, excludedTitles } =
        filterPromoArticles(unseenArticles);

      console.log(
        `[digest-tech] ${recentArticles.length} fetched; ` +
          `${unseenArticles.length} new; ${totalExcluded} promo excluded`
      );

      if (newArticles.length === 0) {
        const prevArticles = await getAllArticles("tech");
        let noNewsMsg = "কোনো নতুন প্রযুক্তি খবর নেই।";
        if (prevArticles.length > 0) {
          const titleList = prevArticles.map((a) => `${a.index}. ${a.title}`).join("\n");
          noNewsMsg += `\n\nআগের রানের আর্টিকেলগুলো:\n${titleList}`;
        }
        await sendMessage(noNewsMsg);
        return NextResponse.json({ status: "no_new_articles" });
      }

      const promoNote =
        totalExcluded > 0
          ? `🚫 ${totalExcluded}টি প্রমো আর্টিকেল বাদ দেওয়া হয়েছে — ` +
            Object.entries(excludedReasons)
              .map(([kw, n]) => `${kw} (${n})`)
              .join(", ") +
            "\n" +
            excludedTitles.map((t, i) => `  ${i + 1}. ${t}`).join("\n")
          : "";

      const totalArticles = newArticles.length;
      const totalBatches = Math.ceil(totalArticles / BATCH_SIZE);

      // Persist everything before returning — subsequent calls read from Redis.
      await saveArticles(newArticles, "tech");
      await markSeen(newUrls, "tech");
      await setQueue(newArticles, "tech");
      await setQueueMeta(
        {
          nextIndex: 1,
          totalArticles,
          totalBatches,
          tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          promoNote,
        },
        "tech"
      );

      await sendMessage(
        `⏳ ${totalArticles}টি নতুন প্রযুক্তি আর্টিকেল পাওয়া গেছে। ` +
          `${totalBatches}টি ব্যাচে পাঠানো হবে।`
      );

      return NextResponse.json({
        status: "initializing",
        total_articles: totalArticles,
        total_batches: totalBatches,
      });
    }

    // ── Calls 2..N: process one batch ────────────────────────────────────────
    const { articles, meta } = queue;
    const { nextIndex, totalArticles, totalBatches, tokens, promoNote } = meta;

    const batch = articles.slice(0, BATCH_SIZE);
    const rest = articles.slice(BATCH_SIZE);
    const isLastBatch = rest.length === 0;
    const currentBatch = Math.floor((nextIndex - 1) / BATCH_SIZE) + 1;

    console.log(
      `[digest-tech] Processing articles ${nextIndex}–${nextIndex + batch.length - 1}` +
        ` (${rest.length} remaining after this batch)…`
    );

    await sendMessage(
      `🔄 ব্যাচ ${currentBatch}/${totalBatches} শুরু হচ্ছে ` +
        `(আর্টিকেল ${nextIndex}–${nextIndex + batch.length - 1})...`
    );

    const { summary, usage } = await summarizeArticles(batch, "tech", nextIndex);

    const updatedTokens = {
      input_tokens: tokens.input_tokens + usage.input_tokens,
      output_tokens: tokens.output_tokens + usage.output_tokens,
      total_tokens: tokens.total_tokens + usage.total_tokens,
    };

    await setQueue(rest, "tech");

    if (isLastBatch) {
      await sendMessage(summary);
      const footer = [
        promoNote || "",
        `📊 টোকেন: ইনপুট ${updatedTokens.input_tokens} · আউটপুট ${updatedTokens.output_tokens} · মোট ${updatedTokens.total_tokens}`,
        `✅ সব ${totalBatches}টি ব্যাচ সম্পন্ন।`,
      ]
        .filter(Boolean)
        .join("\n");
      await sendMessage(footer);
      await clearQueueMeta("tech");
      console.log("[digest-tech] All batches complete.");
    } else {
      await sendMessage(summary);
      await sendMessage(`✅ ব্যাচ ${currentBatch}/${totalBatches} সম্পন্ন।`);
      await setQueueMeta(
        {
          nextIndex: nextIndex + BATCH_SIZE,
          totalArticles,
          totalBatches,
          tokens: updatedTokens,
          promoNote,
        },
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
