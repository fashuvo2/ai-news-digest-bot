/**
 * /app/api/webhook/route.js
 *
 * Telegram webhook — receives incoming messages from the bot and handles
 * deep-dive requests.
 *
 * Usage: send the bot a message with just an article number (e.g. "3")
 * and it will reply with an in-depth Bengali analysis of that article.
 *
 * Commands:
 *   <number>       — deep dive into article N from the last digest
 *   /help          — show available commands
 */

import { NextResponse, after } from "next/server";
import { getArticle, getArticleCount, markUpdateSeen } from "@/lib/storage";
import { deepDiveArticle } from "@/lib/deepDive";
import { sendReply } from "@/lib/telegram";

// ── Security ───────────────────────────────────────────────────────────────────

/**
 * Telegram sends a secret token header when the webhook is registered with
 * a `secret_token`. We verify it against TELEGRAM_WEBHOOK_SECRET.
 * Falls back to always-allow if the env var is not set (useful in dev).
 */
function isAuthorised(request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured — open (set one in production)
  return request.headers.get("x-telegram-bot-api-secret-token") === secret;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function POST(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Deduplicate: Telegram retries failed webhooks; process each update_id only once.
  const isNew = await markUpdateSeen(update.update_id);
  if (!isNew) {
    return NextResponse.json({ ok: true }); // already processed — ignore retry
  }

  // We only handle regular text messages.
  const message = update?.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true }); // ignore non-text updates
  }

  const chatId = message.chat.id;
  const messageId = message.message_id;
  const text = message.text.trim();

  // ── /help command ────────────────────────────────────────────────────────────
  if (text === "/help" || text === "/start") {
    const helpText =
      "🤖 <b>AI সংবাদ ডাইজেস্ট বট</b>\n\n" +
      "কোনো আর্টিকেল সম্পর্কে বিস্তারিত জানতে চাইলে সেটির নম্বর পাঠান।\n\n" +
      "<b>উদাহরণ:</b>\n" +
      "• <code>3</code> — ৩ নম্বর আর্টিকেলের বিস্তারিত বিশ্লেষণ পান\n" +
      "• <code>1,3,5</code> — একসাথে একাধিক আর্টিকেলের বিশ্লেষণ পান\n\n" +
      "ডাইজেস্ট আসার পর ১৩ ঘণ্টার মধ্যে যেকোনো আর্টিকেলের নম্বর পাঠাতে পারবেন।";

    await sendReply(chatId, messageId, helpText);
    return NextResponse.json({ ok: true });
  }

  // ── Article number ────────────────────────────────────────────────────────────
  const num = parseInt(text, 10);
  if (!isNaN(num) && String(num) === text && num > 0) {
    // Return 200 immediately so Telegram won't retry, then process in background.
    after(async () => {
      try {
        const article = await getArticle(num, "ai");

        if (!article) {
          const count = await getArticleCount("ai");
          const countMsg =
            count > 0
              ? `সর্বশেষ AI ডাইজেস্টে ${count}টি আর্টিকেল ছিল। ১–${count} এর মধ্যে একটি নম্বর পাঠান।`
              : "সর্বশেষ AI ডাইজেস্টের আর্টিকেলগুলি আর পাওয়া যাচ্ছে না। পরবর্তী ডাইজেস্টের পর চেষ্টা করুন।";
          await sendReply(chatId, messageId, `❌ ${num} নম্বর আর্টিকেল পাওয়া যায়নি।\n\n${countMsg}`);
          return;
        }

        await sendReply(chatId, messageId, `⏳ <b>${article.title}</b> — বিশ্লেষণ তৈরি হচ্ছে…`);

        const { analysis, usage } = await deepDiveArticle(article);
        const footer =
          "\n——————————————\n" +
          `📊 টোকেন: ${usage.total_tokens.toLocaleString("bn-BD")}`;
        await sendReply(chatId, messageId, analysis + footer);
      } catch (err) {
        console.error("[webhook] Deep-dive error:", err);
        await sendReply(chatId, messageId, "⚠️ দুঃখিত, বিশ্লেষণ তৈরিতে একটি সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।");
      }
    });
    return NextResponse.json({ ok: true });
  }

  // ── Comma-separated list (e.g. "1,3,5") ──────────────────────────────────────
  const commaParts = text.split(",").map((s) => s.trim());
  const commaNums = commaParts.map((s) => parseInt(s, 10));
  const isValidList =
    commaParts.length > 1 &&
    commaNums.every((n, i) => !isNaN(n) && String(n) === commaParts[i] && n > 0);

  if (isValidList) {
    // Return 200 immediately — multiple deep-dives will far exceed Telegram's timeout.
    after(async () => {
      await sendReply(chatId, messageId, `⏳ ${commaNums.length}টি আর্টিকেলের বিশ্লেষণ শুরু হচ্ছে…`);
      for (const num of commaNums) {
        try {
          const article = await getArticle(num, "ai");
          if (!article) {
            await sendReply(chatId, messageId, `❌ ${num} নম্বর আর্টিকেল পাওয়া যায়নি।`);
            continue;
          }
          await sendReply(chatId, messageId, `⏳ <b>${article.title}</b> (${num}) — বিশ্লেষণ তৈরি হচ্ছে…`);
          const { analysis, usage } = await deepDiveArticle(article);
          const footer =
            "\n——————————————\n" +
            `📊 টোকেন: ${usage.total_tokens.toLocaleString("bn-BD")}`;
          await sendReply(chatId, messageId, analysis + footer);
        } catch (err) {
          console.error(`[webhook] Deep-dive error for article ${num}:`, err);
          await sendReply(chatId, messageId, `⚠️ ${num} নম্বর আর্টিকেলের বিশ্লেষণে সমস্যা হয়েছে।`);
        }
      }
    });
    return NextResponse.json({ ok: true });
  }

  // ── Unknown input ─────────────────────────────────────────────────────────────
  await sendReply(
    chatId,
    messageId,
    "কোনো আর্টিকেলের বিস্তারিত জানতে তার নম্বর পাঠান (যেমন: <code>3</code>)।\nএকসাথে একাধিকের জন্য: <code>1,3,5</code>\n/help — সাহায্য"
  );

  return NextResponse.json({ ok: true });
}

// Telegram only uses POST for webhooks.
export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
