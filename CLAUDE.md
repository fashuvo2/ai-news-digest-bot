# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start Next.js dev server at http://localhost:3000
npm run build    # Production build
npm run lint     # ESLint check
```

**Test endpoints locally:**
```bash
# Health check
curl http://localhost:3000/api/health

# Trigger AI digest
curl -X POST http://localhost:3000/api/digest \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"

# Trigger tech digest
curl -X POST http://localhost:3000/api/digest-tech \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"

# Debug feed status (shows per-feed fetch results, no Telegram send)
curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/debug
```

**Local setup:** Copy `.env.example` to `.env.local` and fill in values. `KV_REST_API_URL` and `KV_REST_API_TOKEN` must be copied manually from the Vercel dashboard (Storage → KV → `.env.local` tab).

## Architecture

This is a Next.js 15 App Router application deployed on Vercel. It has **two independent digest pipelines** (AI and Tech) sharing common library code.

### Data flow (both pipelines)

```
GitHub Actions (manual trigger)
  → POST /api/digest  OR  /api/digest-tech
    → lib/fetchFeeds.js  (fetch RSS/Atom feeds in parallel)
    → lib/storage.js filterUnseen()  (deduplicate via Upstash Redis)
    → lib/summarize.js  (Claude API → Bengali digest)
    → lib/storage.js markSeen() + saveArticles()
    → lib/telegram.js sendDigest()  (post to Telegram chat)
```

### Deep-dive flow (on-demand, user-initiated)

```
User sends article number to Telegram bot
  → Telegram webhook → POST /api/webhook
    → lib/storage.js getArticle()  (look up article from last digest)
    → lib/deepDive.js  (fetch full article text + Claude analysis)
    → lib/telegram.js sendReply()
```

### Key files

| File | Purpose |
|---|---|
| `lib/sources.js` | RSS feed URLs for AI digest |
| `lib/sources-tech.js` | RSS feed URLs for Tech digest |
| `lib/fetchFeeds.js` | Parallel RSS fetch + time-window filter |
| `lib/summarize.js` | Claude API: builds Bengali digest with `TOPIC_CONFIG` for "ai"/"tech" |
| `lib/deepDive.js` | Claude API: fetches article HTML, produces detailed Bengali analysis |
| `lib/storage.js` | Upstash Redis: deduplication (72h TTL) + article store (13h TTL) |
| `lib/telegram.js` | Telegram Bot API: `sendDigest`, `sendMessage`, `sendReply` |
| `app/api/digest/route.js` | AI digest endpoint (POST, 24h window) |
| `app/api/digest-tech/route.js` | Tech digest endpoint (POST, 12h window) |
| `app/api/webhook/route.js` | Telegram webhook: handles article number → deep dive |
| `app/api/debug/route.js` | Feed diagnostics (GET, no Telegram send) |

### Redis key schema

- `digest:seen:{ns}:{url}` — deduplication flag, 72h TTL (`ns` = "ai" or "tech")
- `digest:last_articles:{ns}` — JSON array of last digest's articles, 13h TTL

### Authentication

- `/api/digest`, `/api/digest-tech`, `/api/debug`: `Authorization: Bearer <CRON_SECRET>` header
- `/api/webhook`: `x-telegram-bot-api-secret-token: <TELEGRAM_WEBHOOK_SECRET>` (optional; open if unset)

### Claude model

Both `lib/summarize.js` and `lib/deepDive.js` use `claude-sonnet-4-20250514`. Digest calls use `max_tokens: 8192`; deep-dive calls use `max_tokens: 2048`.

### Adding/removing RSS sources

Edit `lib/sources.js` (AI pipeline) or `lib/sources-tech.js` (Tech pipeline). Each entry needs `{ name, url }`. Run `/api/debug` after changes to verify all feeds parse correctly.

### GitHub Actions

Both workflows (`.github/workflows/trigger.yml` and `trigger-tech.yml`) are `workflow_dispatch` only — triggered manually from the GitHub Actions UI. Required secrets: `VERCEL_APP_URL` (without `https://`) and `CRON_SECRET`.
