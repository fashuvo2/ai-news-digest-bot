/**
 * /app/api/webhook-tech/route.js
 *
 * Telegram webhook for the Tech digest bot.
 * Mirrors /api/webhook but uses TELEGRAM_BOT_TOKEN_TECH and the "tech" namespace.
 *
 * Register this with your Tech bot:
 *   POST https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN_TECH>/setWebhook
 *   { "url": "https://<your-app>.vercel.app/api/webhook-tech" }
 *
 * Commands:
 *   <number>  — deep dive into article N from the last Tech digest
 *   /help     — show available commands
 */

import { NextResponse, after } from "next/server";
import { getArticle, getArticleCount, markUpdateSeen } from "@/lib/storage";
import { deepDiveArticle } from "@/lib/deepDive";
import { sendReplyAs } from "@/lib/telegram";

function getBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN_TECH;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN_TECH is not set");
  return token;
}

function isAuthorised(request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET_TECH;
  if (!secret) return true;
  return request.headers.get("x-telegram-bot-api-secret-token") === secret;
}

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

  const message = update?.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const chatId = message.chat.id;
  const messageId = message.message_id;
  const text = message.text.trim();
  const token = getBotToken();

  // ── /help command ────────────────────────────────────────────────────────────
  if (text === "/help" || text === "/start") {
    const helpText =
      "💻 <b>টেক সংবাদ ডাইজেস্ট বট</b>\n\n" +
      "কোনো আর্টিকেল সম্পর্কে বিস্তারিত জানতে চাইলে সেটির নম্বর পাঠান।\n\n" +
      "<b>উদাহরণ:</b>\n" +
      "• <code>3</code> — ৩ নম্বর আর্টিকেলের বিস্তারিত বিশ্লেষণ পান\n" +
      "• <code>1,3,5</code> — একসাথে একাধিক আর্টিকেলের বিশ্লেষণ পান\n\n" +
      "ডাইজেস্ট আসার পর ১৩ ঘণ্টার মধ্যে যেকোনো আর্টিকেলের নম্বর পাঠাতে পারবেন।";

    await sendReplyAs(chatId, messageId, helpText, token);
    return NextResponse.json({ ok: true });
  }

  // ── Article number ────────────────────────────────────────────────────────────
  const num = parseInt(text, 10);
  if (!isNaN(num) && String(num) === text && num > 0) {
    // Return 200 immediately so Telegram won't retry, then process in background.
    after(async () => {
      try {
        const article = await getArticle(num, "tech");

        if (!article) {
          const count = await getArticleCount("tech");
          const countMsg =
            count > 0
              ? `সর্বশেষ টেক ডাইজেস্টে ${count}টি আর্টিকেল ছিল। ১–${count} এর মধ্যে একটি নম্বর পাঠান।`
              : "সর্বশেষ টেক ডাইজেস্টের আর্টিকেলগুলি আর পাওয়া যাচ্ছে না। পরবর্তী ডাইজেস্টের পর চেষ্টা করুন।";
          await sendReplyAs(chatId, messageId, `❌ ${num} নম্বর আর্টিকেল পাওয়া যায়নি।\n\n${countMsg}`, token);
          return;
        }

        await sendReplyAs(chatId, messageId, `⏳ <b>${article.title}</b> — বিশ্লেষণ তৈরি হচ্ছে…`, token);

        const { analysis, usage } = await deepDiveArticle(article);
        const footer =
          "\n——————————————\n" +
          `📊 টোকেন: ${usage.total_tokens.toLocaleString("bn-BD")}`;
        await sendReplyAs(chatId, messageId, analysis + footer, token);
      } catch (err) {
        console.error("[webhook-tech] Deep-dive error:", err);
        await sendReplyAs(chatId, messageId, "⚠️ দুঃখিত, বিশ্লেষণ তৈরিতে একটি সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।", token);
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
      await sendReplyAs(chatId, messageId, `⏳ ${commaNums.length}টি আর্টিকেলের বিশ্লেষণ শুরু হচ্ছে…`, token);
      for (const num of commaNums) {
        try {
          const article = await getArticle(num, "tech");
          if (!article) {
            await sendReplyAs(chatId, messageId, `❌ ${num} নম্বর আর্টিকেল পাওয়া যায়নি।`, token);
            continue;
          }
          await sendReplyAs(chatId, messageId, `⏳ <b>${article.title}</b> (${num}) — বিশ্লেষণ তৈরি হচ্ছে…`, token);
          const { analysis, usage } = await deepDiveArticle(article);
          const footer =
            "\n——————————————\n" +
            `📊 টোকেন: ${usage.total_tokens.toLocaleString("bn-BD")}`;
          await sendReplyAs(chatId, messageId, analysis + footer, token);
        } catch (err) {
          console.error(`[webhook-tech] Deep-dive error for article ${num}:`, err);
          await sendReplyAs(chatId, messageId, `⚠️ ${num} নম্বর আর্টিকেলের বিশ্লেষণে সমস্যা হয়েছে।`, token);
        }
      }
    });
    return NextResponse.json({ ok: true });
  }

  // ── Unknown input ─────────────────────────────────────────────────────────────
  await sendReplyAs(
    chatId,
    messageId,
    "কোনো আর্টিকেলের বিস্তারিত জানতে তার নম্বর পাঠান (যেমন: <code>3</code>)।\nএকসাথে একাধিকের জন্য: <code>1,3,5</code>\n/help — সাহায্য",
    token
  );

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
