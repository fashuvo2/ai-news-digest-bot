#!/usr/bin/env node
/**
 * scripts/digest-tech.js
 *
 * Tech news digest — runs directly in GitHub Actions with no Vercel
 * function timeout constraints. Uses the same library code as the API routes.
 *
 * Required GitHub secrets (passed as environment variables):
 *   ANTHROPIC_API_KEY  — Claude API key
 *   KV_REST_API_URL    — Upstash Redis REST URL
 *   KV_REST_API_TOKEN  — Upstash Redis REST token
 *   TELEGRAM_BOT_TOKEN — Telegram bot token
 *   TELEGRAM_CHAT_ID   — Telegram chat/channel ID
 */

"use strict";

const { fetchRecentArticles, filterPromoArticles } = require("../lib/fetchFeeds");
const { summarizeArticles } = require("../lib/summarize");
const { sendMessage, sendHTMLMessage } = require("../lib/telegram");
const { filterUnseen, markSeen, saveArticles } = require("../lib/storage");
const TECH_SOURCES = require("../lib/sources-tech");

const BATCH_SIZE = 10;

async function run() {
  console.log("[digest-tech] Starting digest run…");

  // ── Fetch RSS feeds ──────────────────────────────────────────────────────────
  const { articles: recentArticles, skippedFeeds } = await fetchRecentArticles(12, TECH_SOURCES);

  if (skippedFeeds.length > 0) {
    await sendMessage(
      `⚠️ ${skippedFeeds.length}টি ফিড লোড হয়নি (টাইমআউট বা এরর): ${skippedFeeds.join(", ")}`
    );
  }

  // ── Deduplicate ──────────────────────────────────────────────────────────────
  const recentUrls = recentArticles.map((a) => a.link || a.url).filter(Boolean);
  const newUrls = await filterUnseen(recentUrls, "tech");
  const unseenArticles = recentArticles.filter((a) => newUrls.includes(a.link || a.url));
  const { kept: newArticles, totalExcluded, excludedReasons } = filterPromoArticles(unseenArticles);

  console.log(
    `[digest-tech] ${recentArticles.length} fetched; ` +
      `${unseenArticles.length} new; ${totalExcluded} promo excluded`
  );

  if (newArticles.length === 0) {
    await sendMessage("কোনো নতুন প্রযুক্তি খবর নেই।");
    console.log("[digest-tech] No new articles. Done.");
    return;
  }

  const promoNote =
    totalExcluded > 0
      ? `🚫 ${totalExcluded}টি প্রমো আর্টিকেল বাদ দেওয়া হয়েছে — ` +
        Object.entries(excludedReasons)
          .map(([kw, n]) => `${kw} (${n})`)
          .join(", ")
      : "";

  const totalBatches = Math.ceil(newArticles.length / BATCH_SIZE);

  // Save all articles upfront with correct 1-based indices for deep-dive lookups.
  await saveArticles(newArticles, "tech");
  // Mark all URLs seen so the next run doesn't reprocess them.
  await markSeen(newUrls, "tech");

  await sendMessage(
    `⏳ ${newArticles.length}টি নতুন প্রযুক্তি আর্টিকেল পাওয়া গেছে। ` +
      `${totalBatches}টি ব্যাচে পাঠানো হবে।`
  );

  // ── Process batches ──────────────────────────────────────────────────────────
  const combinedTokens = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  for (let i = 0; i < totalBatches; i++) {
    const startIndex = i * BATCH_SIZE + 1;
    const batch = newArticles.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const currentBatch = i + 1;
    const isLast = currentBatch === totalBatches;

    console.log(
      `[digest-tech] Batch ${currentBatch}/${totalBatches} ` +
        `(articles ${startIndex}–${startIndex + batch.length - 1})…`
    );

    await sendMessage(
      `🔄 ব্যাচ ${currentBatch}/${totalBatches} শুরু হচ্ছে ` +
        `(আর্টিকেল ${startIndex}–${startIndex + batch.length - 1})...`
    );

    const { summary, usage } = await summarizeArticles(batch, "tech", startIndex);
    combinedTokens.input_tokens += usage.input_tokens;
    combinedTokens.output_tokens += usage.output_tokens;
    combinedTokens.total_tokens += usage.total_tokens;

    // Digest content uses HTML parse mode so <b> and <a> tags render correctly.
    await sendHTMLMessage(summary);

    if (isLast) {
      const footer = [
        promoNote,
        `📊 টোকেন: ইনপুট ${combinedTokens.input_tokens} · আউটপুট ${combinedTokens.output_tokens} · মোট ${combinedTokens.total_tokens}`,
        `✅ সব ${totalBatches}টি ব্যাচ সম্পন্ন।`,
      ]
        .filter(Boolean)
        .join("\n");
      await sendMessage(footer);
    } else {
      await sendMessage(`✅ ব্যাচ ${currentBatch}/${totalBatches} সম্পন্ন।`);
    }
  }

  console.log("[digest-tech] All done.");
}

run().catch((err) => {
  console.error("[digest-tech] Fatal error:", err);
  process.exit(1);
});
