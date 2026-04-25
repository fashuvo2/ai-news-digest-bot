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

# Reset seen-URL deduplication cache (both namespaces)
curl -X POST http://localhost:3000/api/reset \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"

# Reset a single namespace only (ai or tech)
curl -X POST http://localhost:3000/api/reset \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"ns":"ai"}'

# Kill switch — check status
curl http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"

# Kill switch — stop all pipelines
curl -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"action":"stop"}'

# Kill switch — resume all pipelines
curl -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"action":"resume"}'
```

**Local setup:** Copy `.env.example` to `.env.local` and fill in values. `KV_REST_API_URL` and `KV_REST_API_TOKEN` must be copied manually from the Vercel dashboard (Storage → KV → `.env.local` tab).

## Architecture

This is a Next.js 15 App Router application deployed on Vercel. It has **two independent digest pipelines** (AI and Tech) sharing common library code.

### Data flow (both pipelines)

```
GitHub Actions (manual trigger)
  → POST /api/digest  OR  /api/digest-tech
    → lib/fetchFeeds.js  fetchRecentArticles()  (fetch RSS/Atom feeds in parallel)
    → lib/fetchFeeds.js  filterPromoArticles()  (drop promo/deal articles by keyword)
    → lib/storage.js filterUnseen()  (deduplicate via Upstash Redis)
    → lib/summarize.js  summarizeBatched()  (Claude API → Bengali digest, 25 articles/batch)
    → lib/storage.js markSeen() + saveArticles()
    → lib/telegram.js sendBatchedDigest()  (post to Telegram chat)
```

### Deep-dive flow (on-demand, user-initiated)

There are **two separate Telegram bots** — one per pipeline. Each bot has its own token, webhook URL, and webhook secret.

```
User sends article number to AI bot
  → Telegram webhook → POST /api/webhook
    → lib/storage.js getArticle(index, "ai")
    → lib/deepDive.js  (fetch full article text + Claude analysis)
    → lib/telegram.js sendReply()

User sends article number to Tech bot
  → Telegram webhook → POST /api/webhook-tech
    → lib/storage.js getArticle(index, "tech")
    → lib/deepDive.js  (fetch full article text + Claude analysis)
    → lib/telegram.js sendReplyAs(..., TELEGRAM_BOT_TOKEN_TECH)
```

### Kill switch (emergency stop)

Both bots support admin commands to stop/resume all pipelines immediately. A single Redis flag (`digest:kill_switch`) blocks all three pipelines (AI digest, Tech digest, deep-dives).

**Telegram commands** (send to either bot; admin-only if `ADMIN_CHAT_ID` is set):
- `/stop` — activate kill switch, clear batch queues, send confirmation
- `/resume` — clear kill switch, send confirmation
- `/status` — show current kill switch state
- `/reset` — clear both seen-URL caches (AI + Tech)
- `/reset ai` — clear AI seen-URL cache only
- `/reset tech` — clear Tech seen-URL cache only

**GitHub Actions** (Actions → Kill Switch → Run workflow → pick stop/resume):
- `.github/workflows/kill-switch.yml` — calls `/api/stop`
- `.github/workflows/reset.yml` — calls `/api/reset` with namespace dropdown

### Key files

| File | Purpose |
|---|---|
| `lib/sources.js` | RSS feed URLs for AI digest |
| `lib/sources-tech.js` | RSS feed URLs for Tech digest |
| `lib/fetchFeeds.js` | Parallel RSS fetch + time-window filter |
| `lib/summarize.js` | Claude API: builds Bengali digest with `TOPIC_CONFIG` for "ai"/"tech" |
| `lib/deepDive.js` | Claude API: fetches article HTML, produces detailed Bengali analysis |
| `lib/storage.js` | Upstash Redis: deduplication (72h TTL) + article store (13h TTL) |
| `lib/telegram.js` | Telegram Bot API: `sendMessage`, `sendReply` (AI bot), `sendReplyAs` (Tech bot) |
| `app/api/digest/route.js` | AI digest endpoint (POST, 24h window) |
| `app/api/digest-tech/route.js` | Tech digest endpoint (POST, 12h window) |
| `app/api/webhook/route.js` | AI bot Telegram webhook: deep-dive + admin commands |
| `app/api/webhook-tech/route.js` | Tech bot Telegram webhook: deep-dive + admin commands |
| `app/api/stop/route.js` | Kill switch endpoint (POST stop/resume, GET status) |
| `app/api/debug/route.js` | Feed diagnostics (GET, no Telegram send) |
| `app/api/reset/route.js` | Clear seen-URL deduplication cache (POST, optional `{"ns":"ai"\|"tech"}`) |

### Redis key schema

- `digest:seen:{ns}:{url}` — deduplication flag, 72h TTL (`ns` = "ai" or "tech")
- `digest:last_articles:{ns}` — JSON array of last digest's articles, 13h TTL
- `digest:queue:{ns}` — remaining articles for in-progress batched run, 4h TTL
- `digest:queue_meta:{ns}` — batch run state (nextIndex, cumulative tokens, promoNote), 4h TTL
- `digest:kill_switch` — emergency stop flag, no TTL (persists until `/resume`)
- `digest:webhook_update:{id}` — Telegram update deduplication, 24h TTL

### Authentication

- `/api/digest`, `/api/digest-tech`, `/api/debug`, `/api/reset`, `/api/stop`: `Authorization: Bearer <CRON_SECRET>` header
- `/api/webhook`: `x-telegram-bot-api-secret-token: <TELEGRAM_WEBHOOK_SECRET>` (optional; open if unset)
- `/api/webhook-tech`: `x-telegram-bot-api-secret-token: <TELEGRAM_WEBHOOK_SECRET_TECH>` (optional; open if unset)
- Admin Telegram commands (`/stop`, `/resume`, `/status`, `/reset`): restricted to `ADMIN_CHAT_ID` if set; open to all if unset

### Module system

`lib/` files use **CommonJS** (`require` / `module.exports`). `app/` files use **ES modules** (`import` / `export`). Keep this consistent when adding new files.

### Claude model

Both `lib/summarize.js` and `lib/deepDive.js` use `claude-sonnet-4-20250514`. Digest calls use `max_tokens: 8192`; deep-dive calls use `max_tokens: 2048`.

### Adding/removing RSS sources

Edit `lib/sources.js` (AI pipeline) or `lib/sources-tech.js` (Tech pipeline). Each entry needs `{ name, url }`. Run `/api/debug` after changes to verify all feeds parse correctly.

### GitHub Actions

All workflows are `workflow_dispatch` only — triggered manually from the GitHub Actions UI. Required secrets: `VERCEL_APP_URL` (without `https://`) and `CRON_SECRET`.

| Workflow | Purpose |
|---|---|
| `trigger.yml` | Trigger AI digest (`/api/digest`) |
| `trigger-tech.yml` | Trigger Tech digest (`/api/digest-tech`) |
| `kill-switch.yml` | Stop or resume all pipelines (`/api/stop`) — dropdown: stop/resume |
| `reset.yml` | Clear seen-URL cache (`/api/reset`) — dropdown: all/ai/tech |

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API access |
| `TELEGRAM_BOT_TOKEN` | Yes | AI digest bot token |
| `TELEGRAM_CHAT_ID` | Yes | Chat ID for AI digest + admin confirmations |
| `TELEGRAM_BOT_TOKEN_TECH` | Yes | Tech digest bot token |
| `CRON_SECRET` | Yes | Protects digest, stop, reset, debug endpoints |
| `KV_REST_API_URL` | Yes | Upstash Redis URL |
| `KV_REST_API_TOKEN` | Yes | Upstash Redis token |
| `TELEGRAM_WEBHOOK_SECRET` | No | Secures `/api/webhook` (recommended in production) |
| `TELEGRAM_WEBHOOK_SECRET_TECH` | No | Secures `/api/webhook-tech` (recommended in production) |
| `ADMIN_CHAT_ID` | No | Restricts bot admin commands to one Telegram chat ID |
