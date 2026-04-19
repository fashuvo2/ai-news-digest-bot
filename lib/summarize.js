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

// Bengali system prompt that instructs Claude how to write the digest.
const SYSTEM_PROMPT =
  "তুমি একজন AI সংবাদ বিশ্লেষক। নিচের AI জগতের সাম্প্রতিক খবরগুলো পড়ে বাংলায় একটি সংক্ষিপ্ত ও তথ্যবহুল ডাইজেস্ট তৈরি করো। প্রতিটি খবরের জন্য ২-৩ বাক্যে মূল বিষয়টি বলো। শিরোনামে 🤖 AI সংবাদ ডাইজেস্ট লেখো এবং শেষে একটি সারসংক্ষেপ যোগ করো। ইমোজি ব্যবহার করো যাতে পড়তে সুন্দর লাগে।";

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
    // Use the snippet / description if available; strip basic HTML tags.
    const snippet = (article.contentSnippet || article.summary || "")
      .replace(/<[^>]*>/g, "")
      .slice(0, 300);

    return [
      `[${idx + 1}] ${title}`,
      url ? `URL: ${url}` : null,
      article.sourceName ? `Source: ${article.sourceName}` : null,
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
 * @returns {Promise<{ summary: string, usage: { input_tokens: number, output_tokens: number, total_tokens: number } }>}
 */
async function summarizeArticles(articles) {
  const userMessage = buildUserMessage(articles);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
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
