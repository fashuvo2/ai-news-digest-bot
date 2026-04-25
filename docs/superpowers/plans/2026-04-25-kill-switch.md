# Kill Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an emergency kill switch that stops all three pipelines (AI digest, Tech digest, deep-dive) from a phone via Telegram commands or GitHub Actions.

**Architecture:** A single Redis key (`digest:kill_switch`) acts as a shared flag. Two trigger paths — a Telegram bot command and a GitHub Actions workflow — both write to it via a new `/api/stop` endpoint. All three pipelines check the flag as their first action after auth and abort with HTTP 503 if set.

**Tech Stack:** Next.js 15 App Router (ES modules in `app/`), CommonJS in `lib/`, Upstash Redis (`@upstash/redis`), Telegram Bot API, GitHub Actions.

---

## File Map

| Action | File | Change |
|--------|------|--------|
| Modify | `lib/storage.js` | Add `getKillSwitch`, `setKillSwitch`, `clearKillSwitch`, `clearQueue` helpers + exports |
| Create | `app/api/stop/route.js` | New stop/resume/status endpoint |
| Modify | `app/api/digest/route.js` | Kill switch check after auth |
| Modify | `app/api/digest-tech/route.js` | Kill switch check after auth (every call) |
| Modify | `app/api/webhook/route.js` | `/stop`, `/resume`, `/status` commands + kill check before each `after()` block |
| Create | `.github/workflows/kill-switch.yml` | GitHub Actions manual trigger |

---

## Task 1: Kill switch helpers in `lib/storage.js`

**Files:**
- Modify: `lib/storage.js`

- [ ] **Step 1: Add four helpers after the `clearQueueMeta` function (before `module.exports`)**

Add these four functions to `lib/storage.js` immediately before the `module.exports` block at line 221:

```js
// ── Kill switch ────────────────────────────────────────────────────────────────
// A single Redis key that, when set, prevents all pipelines from running.
// No TTL — persists until explicitly cleared via clearKillSwitch().

const KILL_SWITCH_KEY = "digest:kill_switch";

/**
 * Returns true if the kill switch is currently active.
 * @returns {Promise<boolean>}
 */
async function getKillSwitch() {
  const val = await redis.get(KILL_SWITCH_KEY);
  return val !== null;
}

/**
 * Activate the kill switch. No TTL — stays until clearKillSwitch() is called.
 * @returns {Promise<void>}
 */
async function setKillSwitch() {
  await redis.set(KILL_SWITCH_KEY, "1");
  console.log("[storage] Kill switch activated.");
}

/**
 * Deactivate the kill switch.
 * @returns {Promise<void>}
 */
async function clearKillSwitch() {
  await redis.del(KILL_SWITCH_KEY);
  console.log("[storage] Kill switch cleared.");
}

/**
 * Delete both queue keys for a namespace, stopping any in-progress batched run.
 * @param {string} [ns="tech"]
 * @returns {Promise<void>}
 */
async function clearQueue(ns = "tech") {
  await Promise.all([
    redis.del(`digest:queue:${ns}`),
    redis.del(`digest:queue_meta:${ns}`),
  ]);
  console.log(`[storage] Queue cleared for namespace "${ns}".`);
}
```

- [ ] **Step 2: Export the four new functions**

Update the `module.exports` block at the bottom of `lib/storage.js` to include the new helpers:

```js
module.exports = {
  filterUnseen, markSeen, saveArticles, getAllArticles, getArticle, getArticleCount,
  markUpdateSeen,
  getQueue, setQueue, setQueueMeta, clearQueueMeta,
  getKillSwitch, setKillSwitch, clearKillSwitch, clearQueue,
};
```

- [ ] **Step 3: Commit**

```bash
git add lib/storage.js
git commit -m "feat: add kill switch helpers to storage.js"
```

---

## Task 2: `/api/stop` endpoint

**Files:**
- Create: `app/api/stop/route.js`

- [ ] **Step 1: Create `app/api/stop/route.js` with the following content**

```js
/**
 * /app/api/stop/route.js
 *
 * Emergency kill switch endpoint.
 *
 * POST { "action": "stop" }   — activates kill switch, clears tech queue, sends Telegram confirmation
 * POST { "action": "resume" } — clears kill switch, sends Telegram confirmation
 * GET                         — returns { active: true/false }, no state change
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */

import { NextResponse } from "next/server";
import { getKillSwitch, setKillSwitch, clearKillSwitch, clearQueue } from "@/lib/storage";
import { sendMessage } from "@/lib/telegram";

function isAuthorised(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[stop] CRON_SECRET is not set — rejecting request");
    return false;
  }
  const authHeader = request.headers.get("authorization") || "";
  return authHeader === `Bearer ${secret}`;
}

export async function POST(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action } = body;

  if (action === "stop") {
    await setKillSwitch();
    await clearQueue("tech");
    await sendMessage("🛑 Kill switch activated. All pipelines stopped.");
    return NextResponse.json({ status: "stopped" });
  }

  if (action === "resume") {
    await clearKillSwitch();
    await sendMessage("✅ Kill switch cleared. Pipelines resumed.");
    return NextResponse.json({ status: "resumed" });
  }

  return NextResponse.json(
    { error: "Invalid action. Use 'stop' or 'resume'." },
    { status: 400 }
  );
}

export async function GET(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const active = await getKillSwitch();
  return NextResponse.json({ active });
}
```

- [ ] **Step 2: Verify the endpoint works locally**

Start the dev server (`npm run dev`), then run:

```bash
# Activate kill switch — expect: {"status":"stopped"} + Telegram confirmation message
curl -s -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"action":"stop"}'

# Check status — expect: {"active":true}
curl -s http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"

# Resume — expect: {"status":"resumed"} + Telegram confirmation message
curl -s -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"action":"resume"}'

# Check status again — expect: {"active":false}
curl -s http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"

# Unauthorised request — expect: {"error":"Unauthorised"} with HTTP 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer wrongsecret" \
  -H "Content-Type: application/json" \
  -d '{"action":"stop"}'
```

- [ ] **Step 3: Commit**

```bash
git add app/api/stop/route.js
git commit -m "feat: add /api/stop kill switch endpoint"
```

---

## Task 3: Kill switch check in `/api/digest`

**Files:**
- Modify: `app/api/digest/route.js`

- [ ] **Step 1: Add `getKillSwitch` to the storage import**

Change line 21 in `app/api/digest/route.js` from:

```js
import { filterUnseen, markSeen, saveArticles, getAllArticles } from "@/lib/storage";
```

to:

```js
import { filterUnseen, markSeen, saveArticles, getAllArticles, getKillSwitch } from "@/lib/storage";
```

- [ ] **Step 2: Add the kill switch check after the auth check**

In `app/api/digest/route.js`, after the existing auth block (after line 49), add:

```js
  // Kill switch check — abort immediately if the emergency stop is active.
  const killed = await getKillSwitch();
  if (killed) {
    console.log("[digest] Kill switch is active — aborting run.");
    return NextResponse.json(
      { status: "stopped", reason: "kill switch active" },
      { status: 503 }
    );
  }
```

The full top of the `POST` handler should now read:

```js
export async function POST(request) {
  // Step 1 — Authorisation check.
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Kill switch check — abort immediately if the emergency stop is active.
  const killed = await getKillSwitch();
  if (killed) {
    console.log("[digest] Kill switch is active — aborting run.");
    return NextResponse.json(
      { status: "stopped", reason: "kill switch active" },
      { status: 503 }
    );
  }

  console.log("[digest] Starting digest run…");
  // ... rest unchanged
```

- [ ] **Step 3: Verify locally**

```bash
# Activate kill switch first
curl -s -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"action":"stop"}'

# Try digest — expect HTTP 503 and {"status":"stopped","reason":"kill switch active"}
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/api/digest \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"

# Resume then try digest — expect normal digest response (or no_new_articles)
curl -s -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"action":"resume"}'
```

- [ ] **Step 4: Commit**

```bash
git add app/api/digest/route.js
git commit -m "feat: check kill switch in /api/digest"
```

---

## Task 4: Kill switch check in `/api/digest-tech`

**Files:**
- Modify: `app/api/digest-tech/route.js`

- [ ] **Step 1: Add `getKillSwitch` to the storage import**

Change lines 22–25 in `app/api/digest-tech/route.js` from:

```js
import {
  filterUnseen, markSeen, saveArticles, getAllArticles,
  getQueue, setQueue, setQueueMeta, clearQueueMeta,
} from "@/lib/storage";
```

to:

```js
import {
  filterUnseen, markSeen, saveArticles, getAllArticles,
  getQueue, setQueue, setQueueMeta, clearQueueMeta,
  getKillSwitch,
} from "@/lib/storage";
```

- [ ] **Step 2: Add the kill switch check after the auth check**

In `app/api/digest-tech/route.js`, after the existing auth block (after line 50), add:

```js
  // Kill switch check — runs on every call (init + every batch).
  const killed = await getKillSwitch();
  if (killed) {
    console.log("[digest-tech] Kill switch is active — aborting.");
    return NextResponse.json(
      { status: "stopped", reason: "kill switch active" },
      { status: 503 }
    );
  }
```

The full top of the `POST` handler should now read:

```js
export async function POST(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Kill switch check — runs on every call (init + every batch).
  const killed = await getKillSwitch();
  if (killed) {
    console.log("[digest-tech] Kill switch is active — aborting.");
    return NextResponse.json(
      { status: "stopped", reason: "kill switch active" },
      { status: 503 }
    );
  }

  console.log("[digest-tech] Call received…");
  // ... rest unchanged
```

- [ ] **Step 3: Verify locally**

```bash
# Activate kill switch
curl -s -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"action":"stop"}'

# Try digest-tech — expect HTTP 503 and {"status":"stopped","reason":"kill switch active"}
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/api/digest-tech \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)"

# Resume
curl -s -X POST http://localhost:3000/api/stop \
  -H "Authorization: Bearer $(grep CRON_SECRET .env.local | cut -d= -f2)" \
  -H "Content-Type: application/json" \
  -d '{"action":"resume"}'
```

- [ ] **Step 4: Commit**

```bash
git add app/api/digest-tech/route.js
git commit -m "feat: check kill switch in /api/digest-tech"
```

---

## Task 5: Telegram commands + kill check in `/api/webhook`

**Files:**
- Modify: `app/api/webhook/route.js`

- [ ] **Step 1: Update the storage import to include kill switch helpers**

Change line 16 in `app/api/webhook/route.js` from:

```js
import { getArticle, getArticleCount, markUpdateSeen } from "@/lib/storage";
```

to:

```js
import { getArticle, getArticleCount, markUpdateSeen, getKillSwitch, setKillSwitch, clearKillSwitch, clearQueue } from "@/lib/storage";
```

- [ ] **Step 2: Add the `isAdmin` helper after the `isAuthorised` function**

Add this function after the closing `}` of `isAuthorised` (after line 31), before the `// ── Handler` comment:

```js
/**
 * Returns true if chatId is allowed to use admin commands (/stop, /resume, /status).
 * If ADMIN_CHAT_ID is not set, all chats are allowed (safe for personal bots).
 */
function isAdmin(chatId) {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) return true;
  return String(chatId) === String(adminId);
}
```

- [ ] **Step 3: Add kill switch commands before the `/help` block**

In `app/api/webhook/route.js`, insert the following block immediately before the `// ── /help command` comment (before line 63):

```js
  // ── Kill switch commands ─────────────────────────────────────────────────────
  if (text === "/stop" || text === "/resume" || text === "/status") {
    if (!isAdmin(chatId)) {
      return NextResponse.json({ ok: true }); // silently ignore non-admin
    }

    if (text === "/stop") {
      await setKillSwitch();
      await clearQueue("tech");
      await sendReply(chatId, messageId, "🛑 Kill switch activated. All pipelines stopped.");
    } else if (text === "/resume") {
      await clearKillSwitch();
      await sendReply(chatId, messageId, "✅ Kill switch cleared. Pipelines resumed.");
    } else {
      const active = await getKillSwitch();
      await sendReply(
        chatId,
        messageId,
        active
          ? "🔴 Kill switch is <b>active</b>. Pipelines are stopped."
          : "🟢 Kill switch is <b>inactive</b>. Pipelines are running normally."
      );
    }
    return NextResponse.json({ ok: true });
  }
```

- [ ] **Step 4: Add kill check inside the single-number `after()` block**

In the single-number `after()` block (starting at line 81), add the kill switch check as the first thing inside the `try`:

Replace:

```js
    after(async () => {
      try {
        const article = await getArticle(num, "ai");
```

with:

```js
    after(async () => {
      try {
        const killed = await getKillSwitch();
        if (killed) {
          await sendReply(chatId, messageId, "⏸️ Deep-dives are currently paused.");
          return;
        }

        const article = await getArticle(num, "ai");
```

- [ ] **Step 5: Add kill check inside the comma-list `after()` block**

In the comma-list `after()` block (starting at line 119), add the kill switch check as the first thing inside:

Replace:

```js
    after(async () => {
      await sendReply(chatId, messageId, `⏳ ${commaNums.length}টি আর্টিকেলের বিশ্লেষণ শুরু হচ্ছে…`);
      for (const num of commaNums) {
```

with:

```js
    after(async () => {
      const killed = await getKillSwitch();
      if (killed) {
        await sendReply(chatId, messageId, "⏸️ Deep-dives are currently paused.");
        return;
      }

      await sendReply(chatId, messageId, `⏳ ${commaNums.length}টি আর্টিকেলের বিশ্লেষণ শুরু হচ্ছে…`);
      for (const num of commaNums) {
```

- [ ] **Step 6: Update the `/help` command text to mention the new commands**

In the `helpText` string (around line 66), append the new commands. Replace the existing `helpText` assignment with:

```js
    const helpText =
      "🤖 <b>AI সংবাদ ডাইজেস্ট বট</b>\n\n" +
      "কোনো আর্টিকেল সম্পর্কে বিস্তারিত জানতে চাইলে সেটির নম্বর পাঠান।\n\n" +
      "<b>উদাহরণ:</b>\n" +
      "• <code>3</code> — ৩ নম্বর আর্টিকেলের বিস্তারিত বিশ্লেষণ পান\n" +
      "• <code>1,3,5</code> — একসাথে একাধিক আর্টিকেলের বিশ্লেষণ পান\n\n" +
      "ডাইজেস্ট আসার পর ১৩ ঘণ্টার মধ্যে যেকোনো আর্টিকেলের নম্বর পাঠাতে পারবেন।\n\n" +
      "<b>অ্যাডমিন কমান্ড:</b>\n" +
      "• <code>/stop</code> — সব পাইপলাইন বন্ধ করুন\n" +
      "• <code>/resume</code> — পাইপলাইন আবার চালু করুন\n" +
      "• <code>/status</code> — কিল সুইচের বর্তমান অবস্থা দেখুন";
```

- [ ] **Step 7: Verify commands work locally**

With the dev server running, send these messages to your Telegram bot (or use the webhook endpoint directly):

```bash
# Simulate /status command via webhook (kill switch should be inactive after previous tasks)
curl -s -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 999001,
    "message": {
      "message_id": 1,
      "chat": {"id": 123456789},
      "text": "/status"
    }
  }'
# Expected: bot replies "🟢 Kill switch is inactive..."

# Activate via Telegram
curl -s -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 999002,
    "message": {
      "message_id": 2,
      "chat": {"id": 123456789},
      "text": "/stop"
    }
  }'
# Expected: bot replies "🛑 Kill switch activated..."

# Try a deep-dive while stopped
curl -s -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 999003,
    "message": {
      "message_id": 3,
      "chat": {"id": 123456789},
      "text": "1"
    }
  }'
# Expected: bot replies "⏸️ Deep-dives are currently paused."

# Resume
curl -s -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "update_id": 999004,
    "message": {
      "message_id": 4,
      "chat": {"id": 123456789},
      "text": "/resume"
    }
  }'
# Expected: bot replies "✅ Kill switch cleared..."
```

Note: These test curl commands bypass `TELEGRAM_WEBHOOK_SECRET` (fine in dev where it's unset). If `ADMIN_CHAT_ID` is set in `.env.local`, use that value as the `chat.id` in the test payloads above.

- [ ] **Step 8: Commit**

```bash
git add app/api/webhook/route.js
git commit -m "feat: add /stop /resume /status commands and kill check to webhook"
```

---

## Task 6: GitHub Actions kill-switch workflow

**Files:**
- Create: `.github/workflows/kill-switch.yml`

- [ ] **Step 1: Create `.github/workflows/kill-switch.yml`**

```yaml
name: Kill Switch

on:
  workflow_dispatch:
    inputs:
      action:
        description: 'Action to perform'
        required: true
        type: choice
        options:
          - stop
          - resume

jobs:
  kill-switch:
    name: ${{ github.event.inputs.action == 'stop' && 'Stop all pipelines' || 'Resume all pipelines' }}
    runs-on: ubuntu-latest

    steps:
      - name: Send kill switch action to /api/stop
        run: |
          HTTP_STATUS=$(curl \
            --silent \
            --output /tmp/response.json \
            --write-out "%{http_code}" \
            --max-time 30 \
            --request POST \
            --header "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            --header "Content-Type: application/json" \
            --data '{"action":"${{ github.event.inputs.action }}"}' \
            "https://${{ secrets.VERCEL_APP_URL }}/api/stop")

          echo "HTTP status: $HTTP_STATUS"
          echo "Response body:"
          cat /tmp/response.json

          if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
            echo "ERROR: API returned HTTP $HTTP_STATUS"
            exit 1
          fi
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/kill-switch.yml
git commit -m "feat: add GitHub Actions kill-switch workflow"
git push
```

- [ ] **Step 3: Verify the workflow appears in GitHub Actions**

Go to your repo on GitHub → Actions tab. You should see "Kill Switch" listed under workflows. Click it → "Run workflow" → confirm the dropdown shows "stop" and "resume" options.

Trigger it with "stop" and confirm:
- The workflow run completes green
- You receive a Telegram confirmation: "🛑 Kill switch activated. All pipelines stopped."
- `GET /api/stop` returns `{"active":true}`

Then trigger "resume" and confirm:
- Telegram confirmation: "✅ Kill switch cleared. Pipelines resumed."
- `GET /api/stop` returns `{"active":false}`

---

## Optional: Add `ADMIN_CHAT_ID` to Vercel env vars

If you want to restrict `/stop`, `/resume`, `/status` to your own Telegram chat ID only:

1. Find your Telegram chat ID: send `/start` to `@userinfobot` on Telegram.
2. Add to Vercel:

```bash
# Via Vercel dashboard: Settings → Environment Variables → add ADMIN_CHAT_ID
# Or via CLI if installed:
vercel env add ADMIN_CHAT_ID production
```

3. Redeploy for the env var to take effect.
