/**
 * RSS / Atom feed sources for general technology news.
 * Add or remove URLs here to change which publications are monitored.
 * All feeds are fetched in parallel on every digest run.
 */
const TECH_SOURCES = [
  // ── Major tech publications ────────────────────────────────────────────────
  {
    name: "The Verge",
    url: "https://www.theverge.com/rss/index.xml",
  },
  {
    name: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
  },
  {
    name: "Wired",
    url: "https://www.wired.com/feed/rss",
  },
  {
    name: "TechCrunch",
    url: "https://techcrunch.com/feed/",
  },
  {
    name: "Engadget",
    url: "https://www.engadget.com/rss.xml",
  },

  // ── Developer & industry news ─────────────────────────────────────────────
  {
    name: "Hacker News",
    url: "https://hnrss.org/frontpage",
  },
  {
    name: "The Register",
    url: "https://www.theregister.com/headlines.atom",
  },
  {
    name: "MIT Technology Review",
    url: "https://www.technologyreview.com/feed",
  },
];

module.exports = TECH_SOURCES;
