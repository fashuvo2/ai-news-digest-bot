/**
 * RSS / Atom feed sources.
 * Add or remove URLs here to change which publications are monitored.
 * All feeds are fetched in parallel on every digest run.
 */
const SOURCES = [
  // ── Official AI lab blogs ──────────────────────────────────────────────────
  {
    name: "Anthropic Blog",
    url: "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml",
  },
  {
    name: "OpenAI Blog",
    url: "https://openai.com/blog/rss.xml",
  },
  {
    name: "Google DeepMind Blog",
    url: "https://deepmind.google/blog/feed/basic/",
  },

  // ── Tech media AI sections ─────────────────────────────────────────────────
  {
    name: "The Verge – AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
  },
  {
    name: "TechCrunch – AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
  },
  {
    name: "MIT Technology Review – AI",
    url: "https://www.technologyreview.com/topic/artificial-intelligence/feed",
  },

  // ── TEMPORARY TEST FEED (remove after confirming digest works) ────────────
  {
    name: "Hacker News – AI",
    url: "https://hnrss.org/newest?q=AI&count=10",
  },

  // ── YouTube channels (Atom feeds) ─────────────────────────────────────────
  {
    name: "YouTube – Andrej Karpathy",
    url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg",
  },
  {
    name: "YouTube – Two Minute Papers",
    url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCbmNph6atAoGfqLoCL_duAg",
  },
  {
    name: "YouTube – AI Explained",
    url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCNJ1Ymd5yFuUPtn21xtRbbw",
  },
];

module.exports = SOURCES;
