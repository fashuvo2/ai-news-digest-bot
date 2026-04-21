/**
 * telegram.js
 * Sends a message to a Telegram chat via the Bot API.
 * Appends a token-usage footer to every digest message.
 */

// node-fetch v3 is ESM-only, but Next.js 14 + Node 18+ have native fetch,
// so we just use the global fetch available in the runtime.

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Low-level helper that calls the Telegram Bot API.
 *
 * @param {string} method  - Bot API method name (e.g. "sendMessage")
 * @param {object} payload - JSON payload for the method
 * @returns {Promise<object>} Telegram API response body
 */
async function callTelegramAPI(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!data.ok) {
    throw new Error(
      `Telegram API error [${method}]: ${data.description || JSON.stringify(data)}`
    );
  }

  return data;
}

/**
 * Build the token-usage footer that is appended to every message.
 *
 * @param {{ input_tokens: number, output_tokens: number, total_tokens: number }} usage
 * @returns {string}
 */
function buildFooter(usage) {
  return (
    "\n——————————————\n" +
    "📊 এই রানে ব্যবহৃত টোকেন:\n" +
    `• ইনপুট: ${usage.input_tokens.toLocaleString("bn-BD")}\n` +
    `• আউটপুট: ${usage.output_tokens.toLocaleString("bn-BD")}\n` +
    `• মোট: ${usage.total_tokens.toLocaleString("bn-BD")}`
  );
}

/**
 * Send the Bengali digest summary to the configured Telegram chat.
 * Telegram has a 4096-character limit per message; long digests are
 * split automatically into multiple messages.
 *
 * @param {string} summaryText  - The Bengali digest produced by Claude
 * @param {{ input_tokens: number, output_tokens: number, total_tokens: number }} usage
 * @returns {Promise<void>}
 */
async function sendDigest(summaryText, usage) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");

  const footer = buildFooter(usage);
  const fullMessage = summaryText + footer;

  // Telegram message limit is 4096 UTF-16 code units.
  const MAX_LENGTH = 4096;

  if (fullMessage.length <= MAX_LENGTH) {
    // Single message — attach footer here.
    await callTelegramAPI("sendMessage", {
      chat_id: chatId,
      text: fullMessage,
      parse_mode: "HTML",
      // Disable link previews to keep the message clean.
      disable_web_page_preview: true,
    });
  } else {
    // Split the summary into chunks, send the footer only on the last chunk.
    const chunks = splitIntoChunks(summaryText, MAX_LENGTH - footer.length - 10);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const text = isLast ? chunks[i] + footer : chunks[i];

      await callTelegramAPI("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
  }

  console.log("[telegram] Message(s) sent successfully.");
}

/**
 * Send a plain informational message (no footer) — used for the
 * "no new articles" notification.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
async function sendMessage(text) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");

  await callTelegramAPI("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });

  console.log("[telegram] Plain message sent.");
}

/**
 * Split a long string into an array of chunks, each no longer than maxLen.
 * Tries to break on newlines to avoid cutting mid-sentence.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitIntoChunks(text, maxLen) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Find the last newline within the allowed length.
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt === -1) breakAt = maxLen; // no newline — hard cut

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Reply to a specific Telegram message.
 * Used by the webhook handler to respond to deep-dive requests.
 *
 * @param {number|string} chatId
 * @param {number} replyToMessageId - The message ID to reply to
 * @param {string} text
 * @returns {Promise<void>}
 */
async function sendReply(chatId, replyToMessageId, text) {
  const MAX_LENGTH = 4096;

  const send = (chunk) =>
    callTelegramAPI("sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_to_message_id: replyToMessageId,
    });

  if (text.length <= MAX_LENGTH) {
    await send(text);
  } else {
    const chunks = splitIntoChunks(text, MAX_LENGTH);
    for (const chunk of chunks) await send(chunk);
  }
}

module.exports = { sendDigest, sendMessage, sendReply };
