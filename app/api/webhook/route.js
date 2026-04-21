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

import { NextResponse } from "next/server";
import { getArticle, getArticleCount } from "@/lib/storage";
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
      "• <code>3</code> — ৩ নম্বর আর্টিকেলের বিস্তারিত বিশ্লেষণ পান\n\n" +
      "ডাইজেস্ট আসার পর ১৩ ঘণ্টার মধ্যে যেকোনো আর্টিকেলের নম্বর পাঠাতে পারবেন।";

    await sendReply(chatId, messageId, helpText);
    return NextResponse.json({ ok: true });
  }

  // ── Article number ────────────────────────────────────────────────────────────
  const num = parseInt(text, 10);
  if (!isNaN(num) && String(num) === text && num > 0) {
    try {
      // Check AI namespace first, then tech namespace.
      let article = await getArticle(num, "ai");
      if (!article) article = await getArticle(num, "tech");

      if (!article) {
        const count = Math.max(
          await getArticleCount("ai"),
          await getArticleCount("tech")
        );
        const countMsg =
          count > 0
            ? `সর্বশেষ ডাইজেস্টে ${count}টি আর্টিকেল ছিল। ১–${count} এর মধ্যে একটি নম্বর পাঠান।`
            : "সর্বশেষ ডাইজেস্টের আর্টিকেলগুলি আর পাওয়া যাচ্ছে না। পরবর্তী ডাইজেস্টের পর চেষ্টা করুন।";

        await sendReply(chatId, messageId, `❌ ${num} নম্বর আর্টিকেল পাওয়া যায়নি।\n\n${countMsg}`);
        return NextResponse.json({ ok: true });
      }

      // Acknowledge immediately so the user knows it's working.
      await sendReply(
        chatId,
        messageId,
        `⏳ <b>${article.title}</b> — বিশ্লেষণ তৈরি হচ্ছে…`
      );

      const { analysis, usage } = await deepDiveArticle(article);

      const footer =
        "\n——————————————\n" +
        `📊 টোকেন: ${usage.total_tokens.toLocaleString("bn-BD")}`;

      await sendReply(chatId, messageId, analysis + footer);
    } catch (err) {
      console.error("[webhook] Deep-dive error:", err);
      await sendReply(
        chatId,
        messageId,
        "⚠️ দুঃখিত, বিশ্লেষণ তৈরিতে একটি সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।"
      );
    }

    return NextResponse.json({ ok: true });
  }

  // ── Unknown input ─────────────────────────────────────────────────────────────
  await sendReply(
    chatId,
    messageId,
    "কোনো আর্টিকেলের বিস্তারিত জানতে তার নম্বর পাঠান (যেমন: <code>3</code>)।\n/help — সাহায্য"
  );

  return NextResponse.json({ ok: true });
}

// Telegram only uses POST for webhooks.
export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
