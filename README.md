# 🤖 AI News Digest Bot

A Next.js 14 app that automatically fetches the latest AI news from 9 RSS/Atom feeds, summarises them in Bengali using Claude, and delivers the digest to a Telegram chat — twice daily via GitHub Actions.

---

## Features

- Fetches 9 AI-focused RSS/Atom feeds in parallel
- Filters articles published in the last 12 hours
- Deduplicates using Vercel KV (Upstash Redis) with a 72-hour TTL
- Summarises in Bengali using `claude-sonnet-4-20250514`
- Reports token usage in every Telegram message
- Scheduled via GitHub Actions (no Vercel cron costs)
- Protected API endpoint with a shared secret

---

## Project Structure

```
.
├── app/
│   ├── api/
│   │   ├── digest/route.js   ← Main digest endpoint (POST)
│   │   └── health/route.js   ← Health check (GET)
│   ├── layout.js
│   └── page.js
├── lib/
│   ├── sources.js            ← RSS feed URLs
│   ├── fetchFeeds.js         ← RSS fetching & filtering
│   ├── summarize.js          ← Claude API integration
│   ├── telegram.js           ← Telegram Bot API sender
│   └── storage.js            ← Vercel KV deduplication
├── .github/
│   └── workflows/
│       └── trigger.yml       ← Twice-daily GitHub Actions trigger
├── .env.example              ← Environment variable template
├── vercel.json
└── package.json
```

---

## Setup Guide

### 1. Clone the Repository

```bash
git clone https://github.com/YOUR_USERNAME/ai-news-digest-bot.git
cd ai-news-digest-bot
npm install
```

---

### 2. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot` and follow the prompts to choose a name and username.
3. Copy the **bot token** (looks like `123456789:ABCdef...`).
4. To get your **chat ID**:
   - For your personal chat: send a message to **@userinfobot**.
   - For a group/channel: add **@userinfobot** to the group, then run `/start`.
   - The bot will reply with your numeric ID (groups are negative numbers).
5. Start the bot by sending it `/start` from your account or group.

---

### 3. Get an Anthropic API Key

1. Visit [console.anthropic.com](https://console.anthropic.com/).
2. Create an account and go to **API Keys**.
3. Click **Create Key** and copy the key.

---

### 4. Generate a CRON_SECRET

This protects your `/api/digest` endpoint from unauthorised calls.

```bash
openssl rand -hex 32
```

Copy the output — you'll need it in the next steps.

---

### 5. Deploy to Vercel

#### 5a. Install the Vercel CLI (optional but recommended)

```bash
npm i -g vercel
```

#### 5b. Import the project

- Go to [vercel.com/new](https://vercel.com/new) and import your GitHub repository.
- Vercel will auto-detect Next.js — click **Deploy** with the defaults.

#### 5c. Add a KV Store (Upstash Redis)

1. In your Vercel project dashboard, go to **Storage** → **Create Database**.
2. Choose **KV** (powered by Upstash Redis).
3. Give it a name (e.g. `digest-kv`) and click **Create**.
4. Vercel will automatically inject `KV_REST_API_URL` and `KV_REST_API_TOKEN` into your project's environment variables.

#### 5d. Add Environment Variables

In your Vercel project → **Settings** → **Environment Variables**, add:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat/channel ID |
| `CRON_SECRET` | The secret you generated in step 4 |

`KV_REST_API_URL` and `KV_REST_API_TOKEN` are added automatically by the KV store.

#### 5e. Redeploy

After adding environment variables, trigger a redeploy from the Vercel dashboard so the app picks them up.

---

### 6. Set Up GitHub Actions Secrets

In your GitHub repository → **Settings** → **Secrets and variables** → **Actions**, add:

| Secret | Value |
|---|---|
| `VERCEL_APP_URL` | Your Vercel deployment URL **without** `https://` (e.g. `my-bot.vercel.app`) |
| `CRON_SECRET` | Same secret you set in Vercel |

---

### 7. Verify the Setup

#### Health check
```bash
curl https://your-app.vercel.app/api/health
# Expected: {"status":"ok"}
```

#### Manual digest trigger
```bash
curl -X POST https://your-app.vercel.app/api/digest \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

You should receive a Telegram message within ~30 seconds.

---

## Schedule

The GitHub Actions workflow runs automatically:

| Time (BST) | Cron (UTC) |
|---|---|
| 07:30 AM | `30 1 * * *` |
| 07:00 PM | `0 13 * * *` |

You can also trigger a manual run from the **Actions** tab → **AI News Digest – Scheduled Trigger** → **Run workflow**.

---

## RSS Sources

| Source | Feed |
|---|---|
| Anthropic Blog | `https://www.anthropic.com/rss.xml` |
| OpenAI Blog | `https://openai.com/blog/rss.xml` |
| Google DeepMind | `https://deepmind.google/blog/rss/` |
| The Verge – AI | `https://www.theverge.com/ai-artificial-intelligence/rss/index.xml` |
| TechCrunch – AI | `https://techcrunch.com/category/artificial-intelligence/feed/` |
| MIT Tech Review | `https://www.technologyreview.com/topic/artificial-intelligence/feed` |
| YouTube – Andrej Karpathy | `https://www.youtube.com/feeds/videos.xml?channel_id=UCbfYPyITQ-7l4upoX8nvctg` |
| YouTube – Two Minute Papers | `https://www.youtube.com/feeds/videos.xml?channel_id=UCbmNph6atAoGfqLoCL_duAg` |
| YouTube – AI Explained | `https://www.youtube.com/feeds/videos.xml?channel_id=UCNJ1Ymd5yFuUPtn21xtRbbw` |

To add or remove sources, edit `lib/sources.js`.

---

## Environment Variables Reference

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat/channel ID to post digests to |
| `CRON_SECRET` | Shared secret to protect `/api/digest` |
| `KV_REST_API_URL` | Auto-injected by Vercel KV |
| `KV_REST_API_TOKEN` | Auto-injected by Vercel KV |

---

## Local Development

```bash
# Copy the example env file and fill in real values
cp .env.example .env.local

# Start the dev server
npm run dev
```

Then test the health endpoint at `http://localhost:3000/api/health` and trigger a digest with:

```bash
curl -X POST http://localhost:3000/api/digest \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"
```

> **Note:** For local development, `KV_REST_API_URL` and `KV_REST_API_TOKEN` must be set manually in `.env.local` — copy them from the Vercel dashboard → Storage → KV → `.env.local` tab.

---

## License

MIT
