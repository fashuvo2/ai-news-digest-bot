/**
 * summarize.js
 * Sends a list of articles to the Claude API and returns a Bengali digest
 * together with the token usage for that API call.
 */

const Anthropic = require("@anthropic-ai/sdk");

// Initialise the Anthropic client — reads ANTHROPIC_API_KEY from env automatically.
const client = new Anthropic();

// The exact model requested for this project.
const MODEL = "claude-sonnet-4-20250514";

/**
 * Convert a publish date into a Bengali "time ago" string.
 * e.g. "৩ ঘণ্টা আগে", "১৫ মিনিট আগে", "২ দিন আগে"
 *
 * @param {string} rawDate
 * @returns {string}
 */
function timeAgo(rawDate) {
  if (!rawDate) return "";
  const diffMs = Date.now() - new Date(rawDate).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  // Convert digits to Bengali numerals
  const toBengali = (n) =>
    String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[d]);

  if (diffMins < 60) return `${toBengali(diffMins)} মিনিট আগে`;
  if (diffHours < 24) return `${toBengali(diffHours)} ঘণ্টা আগে`;
  return `${toBengali(diffDays)} দিন আগে`;
}

/**
 * Extract just the hostname from a URL.
 * e.g. "https://techcrunch.com/2026/..." → "techcrunch.com"
 *
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Topic configuration for the Bengali digest header and label.
const TOPIC_CONFIG = {
  ai: {
    analyst: "AI সংবাদ বিশ্লেষক",
    world: "AI জগতের",
    header: "🤖 AI সংবাদ ডাইজেস্ট",
  },
  tech: {
    analyst: "প্রযুক্তি সংবাদ বিশ্লেষক",
    world: "প্রযুক্তি জগতের",
    header: "💻 টেক সংবাদ ডাইজেস্ট",
  },
};

/**
 * Build the system prompt, injecting the total article count into the header.
 *
 * @param {number} count
 * @param {string} [topic="ai"] - "ai" or "tech"
 * @returns {string}
 */
function buildSystemPrompt(count, topic = "ai") {
  const toBengali = (n) =>
    String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[d]);

  const cfg = TOPIC_CONFIG[topic] || TOPIC_CONFIG.ai;

  return (
    `তুমি একজন ${cfg.analyst}। নিচের ${cfg.world} সাম্প্রতিক ${toBengali(count)}টি খবর পড়ে বাংলায় একটি সংক্ষিপ্ত ও তথ্যবহুল ডাইজেস্ট তৈরি করো। কোনো Markdown চিহ্ন যেমন #, ##, *, ** ব্যবহার করবে না।\n\n` +
    `ডাইজেস্টের শুরুতে হুবহু এই লাইনটি লেখো (HTML ট্যাগসহ):\n` +
    `<b>${cfg.header} — ${toBengali(count)}টি খবর</b>\n\n` +
    `প্রতিটি খবরের জন্য নিচের ফরম্যাট অনুসরণ করো:\n\n` +
    `——————————————\n` +
    `<b>[নম্বর]. [প্রাসঙ্গিক ইমোজি] [মূল ইংরেজি শিরোনাম]</b>\n` +
    `🕐 [সময় — যেমন: ৩ ঘণ্টা আগে]\n` +
    `• [প্রথম বাক্য]\n` +
    `• [দ্বিতীয় বাক্য]\n` +
    `• [তৃতীয় বাক্য]\n` +
    `🔗 [Source Name] · <a href="FULL_URL">domain.com</a>\n\n` +
    `নিয়ম:\n` +
    `- শিরোনাম <b>bold</b> করো\n` +
    `- [নম্বর] এর জায়গায় আর্টিকেলের ক্রমিক সংখ্যা দাও (যেমন: 1, 2, 3) — ব্যবহারকারী এই নম্বর পাঠিয়ে বিস্তারিত জানতে পারবেন\n` +
    `- সময় metadata থেকে নাও (যেমন: ৩ ঘণ্টা আগে)\n` +
    `- প্রতিটি বাক্য আলাদা bullet point (•) হিসেবে দাও\n` +
    `- লিংকে FULL_URL এর জায়গায় আর্টিকেলের পূর্ণ URL এবং domain.com এর জায়গায় শুধু ডোমেইন নাম দাও\n` +
    `- Source Name এর জায়গায় সোর্সের নাম দাও (যেমন: TechCrunch, The Verge)\n\n` +
    `সব খবরের পরে একটি ——————————————  দিয়ে শেষে বাংলায় একটি সংক্ষিপ্ত সারসংক্ষেপ যোগ করো।`
  );
}

/**
 * Format articles into the plaintext block that gets sent to Claude.
 *
 * @param {Array} articles
 * @returns {string}
 */
function buildUserMessage(articles) {
  const lines = articles.map((article, idx) => {
    const title = article.title || "(শিরোনাম নেই)";
    const url = article.link || article.url || "";
    const domain = url ? extractDomain(url) : "";
    const published = timeAgo(article.isoDate || article.pubDate);
    const snippet = (article.contentSnippet || article.summary || "")
      .replace(/<[^>]*>/g, "")
      .slice(0, 300);

    return [
      `[${idx + 1}] ${title}`,
      url ? `URL: ${url}` : null,
      domain ? `Domain: ${domain}` : null,
      article.sourceName ? `Source: ${article.sourceName}` : null,
      published ? `Published: ${published}` : null,
      snippet ? `Description: ${snippet}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return lines.join("\n\n");
}

/**
 * Send articles to Claude and receive a Bengali summary + token usage.
 *
 * @param {Array} articles - Filtered list of new articles to summarise
 * @param {string} [topic="ai"] - "ai" or "tech" — controls the digest header
 * @returns {Promise<{ summary: string, usage: { input_tokens: number, output_tokens: number, total_tokens: number } }>}
 */
async function summarizeArticles(articles, topic = "ai") {
  const systemPrompt = buildSystemPrompt(articles.length, topic);
  const userMessage = buildUserMessage(articles);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  // Extract the Bengali text from the first content block.
  const summary = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  // Extract token usage — Claude always returns this in response.usage.
  const { input_tokens, output_tokens } = response.usage;
  const total_tokens = input_tokens + output_tokens;

  console.log(
    `[summarize] Tokens used — input: ${input_tokens}, output: ${output_tokens}, total: ${total_tokens}`
  );

  return {
    summary,
    usage: { input_tokens, output_tokens, total_tokens },
  };
}

module.exports = { summarizeArticles };
