/**
 * deepDive.js
 * Fetches the full text of an article and asks Claude for an in-depth
 * Bengali analysis, returning the result and token usage.
 */

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();
const MODEL = "claude-sonnet-4-20250514";

/**
 * Attempt to fetch the article URL and extract readable text.
 * Falls back to an empty string on any error (paywalled / unreachable).
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchArticleText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AI-news-digest/1.0; +https://github.com)",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return "";

    const html = await res.text();

    // Strip script/style blocks first, then all remaining tags.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Cap at 6 000 chars to stay within token budget.
    return text.slice(0, 6_000);
  } catch {
    return "";
  }
}

/**
 * Ask Claude for a deep-dive Bengali analysis of a single article.
 *
 * @param {{ title: string, url: string, sourceName: string, snippet: string }} article
 * @returns {Promise<{ analysis: string, usage: { input_tokens: number, output_tokens: number, total_tokens: number } }>}
 */
async function deepDiveArticle(article) {
  const fullText = await fetchArticleText(article.url);

  const systemPrompt =
    "তুমি একজন AI সংবাদ বিশ্লেষক। নিচে দেওয়া আর্টিকেলটি বিশ্লেষণ করে বাংলায় একটি বিস্তারিত রিপোর্ট তৈরি করো। " +
    "কোনো Markdown চিহ্ন যেমন #, ##, *, ** ব্যবহার করবে না। HTML ট্যাগ শুধুমাত্র <b>, <blockquote> এবং <a href=\"...\"> ব্যবহার করতে পারবে।\n\n" +
    "রিপোর্টের কাঠামো:\n" +
    "<b>🔍 [আর্টিকেলের মূল ইংরেজি শিরোনাম]</b>\n" +
    "🔗 <a href=\"ARTICLE_URL\">সম্পূর্ণ আর্টিকেল পড়ুন</a>\n\n" +
    "——————————————\n" +
    "<b>📌 মূল বিষয়:</b>\n" +
    "<blockquote>[আর্টিকেলটি কী নিয়ে — ২-৩ বাক্যে]</blockquote>\n\n" +
    "<b>🔎 বিস্তারিত বিশ্লেষণ:</b>\n" +
    "• [প্রথম গুরুত্বপূর্ণ পয়েন্ট]\n" +
    "• [দ্বিতীয় গুরুত্বপূর্ণ পয়েন্ট]\n" +
    "• [তৃতীয় গুরুত্বপূর্ণ পয়েন্ট]\n" +
    "• [চতুর্থ পয়েন্ট — যদি প্রযোজ্য]\n\n" +
    "<b>💡 কেন গুরুত্বপূর্ণ:</b>\n" +
    "[AI/প্রযুক্তি জগতে এই খবরের তাৎপর্য]\n\n" +
    "——————————————\n" +
    "📰 সূত্র: [Source Name]";

  const userContent = [
    `শিরোনাম: ${article.title}`,
    `URL: ${article.url}`,
    `সূত্র: ${article.sourceName}`,
    article.snippet ? `সংক্ষিপ্ত বিবরণ: ${article.snippet}` : null,
    fullText ? `আর্টিকেলের পূর্ণ বিষয়বস্তু:\n${fullText}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  const analysis = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const { input_tokens, output_tokens } = response.usage;

  return {
    analysis,
    usage: { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens },
  };
}

module.exports = { deepDiveArticle };
