# Kill Switch Design

**Date:** 2026-04-25  
**Status:** Approved

## Problem

Two emergency scenarios require immediate ability to stop all processing from a phone:
1. Runaway API costs (digest looping or running repeatedly)
2. Bot flooding the Telegram chat with messages

## Goals

- Stop all three pipelines (AI digest, Tech digest, deep-dive) after the current in-flight Claude call finishes
- Triggerable from phone in under 10 seconds
- Two independent trigger paths so one works even if the other is broken
- Resume with equal ease

## Out of Scope

- Interrupting an in-flight Claude API call (not possible)
- Per-pipeline granularity (one flag stops everything)

---

## Architecture

One Redis key (`digest:kill_switch`) acts as the shared flag. Two trigger paths both write to it via the same `/api/stop` endpoint.

```
Phone
 ├── Telegram /stop  ──────────────────────────────────────┐
 └── GitHub Actions kill-switch.yml  ──► POST /api/stop  ──┼─► Redis: digest:kill_switch
                                                            │
                                              ┌─────────────┘
                                              │  also clears:
                                              │  digest:queue:tech
                                              │  digest:queue_meta:tech
                                              ▼
             /api/digest ─────► check flag → abort if set
             /api/digest-tech ─► check flag → abort if set (every call)
             /api/webhook ─────► check flag → skip deep-dive if set
```

---

## Components

### 1. Redis kill flag

- **Key**: `digest:kill_switch`
- **Value**: `1`
- **TTL**: none — persists until explicitly cleared via `/resume`
- Set and cleared only by `/api/stop`

### 2. `/api/stop` endpoint

**File**: `app/api/stop/route.js`  
**Auth**: `Authorization: Bearer <CRON_SECRET>`

| Method | Action |
|--------|--------|
| POST `{ "action": "stop" }` | Sets `digest:kill_switch`, deletes `digest:queue:tech` and `digest:queue_meta:tech`, sends Telegram confirmation |
| POST `{ "action": "resume" }` | Deletes `digest:kill_switch`, sends Telegram confirmation |
| GET | Returns `{ active: true/false }` — status check, no state change |

Both stop and resume send a Telegram message to confirm the action worked.

### 3. Pipeline kill switch checks

Each pipeline checks the flag as its **first action after auth**.

**`/api/digest`**
- Checks flag before fetching feeds
- If set: returns `{ status: "stopped", reason: "kill switch active" }` with HTTP 503
- GitHub Actions sees non-200 and fails the workflow run

**`/api/digest-tech`**
- Checks flag on every call (init + every batch)
- If set: returns HTTP 503
- GitHub Actions loop exits; queue was already cleared by `/api/stop`

**`/api/webhook`** (deep-dive only)
- Checks flag inside the `after()` background handler, before article fetch
- If set: sends Telegram reply "Deep-dives are currently paused." then returns
- Regular message deduplication still runs normally

None of the pipelines clear the flag themselves.

### 4. Telegram commands

Handled in `app/api/webhook/route.js`, parsed before the article-number logic.

| Command | Action |
|---------|--------|
| `/stop` | Sets kill flag, clears queue, sends confirmation |
| `/resume` | Clears kill flag, sends confirmation |
| `/status` | Replies with current state (active / inactive) |

**Auth**: `ADMIN_CHAT_ID` env var. If set, these commands only respond to messages from that chat ID. If unset, any chat can use them (acceptable for a personal bot).

### 5. GitHub Actions kill-switch workflow

**File**: `.github/workflows/kill-switch.yml`  
**Trigger**: `workflow_dispatch`  
**Input**: `action` — dropdown with choices `stop` and `resume`  
**Secrets used**: `VERCEL_APP_URL`, `CRON_SECRET` (no new secrets needed)

Single step: `curl -X POST` to `/api/stop` with the chosen action.

From GitHub mobile: Actions → kill-switch → Run workflow → pick action → Run (~6 taps).

---

## Data Flow: Stop Sequence

```
User sends /stop (or triggers GH Actions)
  → POST /api/stop { action: "stop" }
    → SET digest:kill_switch 1
    → DEL digest:queue:tech
    → DEL digest:queue_meta:tech
    → sendMessage(chatId, "🛑 Kill switch activated. All pipelines stopped.")
    → return { status: "stopped" }

Next pipeline call (any of the three):
  → GET digest:kill_switch → "1"
  → return 503 / skip deep-dive
```

## Data Flow: Resume Sequence

```
User sends /resume (or triggers GH Actions)
  → POST /api/stop { action: "resume" }
    → DEL digest:kill_switch
    → sendMessage(chatId, "✅ Kill switch cleared. Pipelines resumed.")
    → return { status: "resumed" }

Next pipeline call:
  → GET digest:kill_switch → null
  → proceeds normally
```

---

## New Files

| File | Purpose |
|------|---------|
| `app/api/stop/route.js` | Stop/resume endpoint |
| `.github/workflows/kill-switch.yml` | GH Actions trigger |

## Modified Files

| File | Change |
|------|--------|
| `app/api/digest/route.js` | Add kill switch check after auth |
| `app/api/digest-tech/route.js` | Add kill switch check after auth (every call) |
| `app/api/webhook/route.js` | Add `/stop`, `/resume`, `/status` commands + kill check before deep-dive |
| `lib/storage.js` | Add `getKillSwitch()`, `setKillSwitch()`, `clearKillSwitch()` helpers |

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `ADMIN_CHAT_ID` | Optional | Restrict Telegram commands to one chat ID |

---

## Testing Plan

1. Set kill switch via Telegram `/stop` → confirm Telegram confirmation received
2. Trigger `/api/digest` → confirm 503 response
3. Check `/api/stop` GET → confirm `{ active: true }`
4. Clear via `/resume` → confirm confirmation
5. Trigger `/api/digest` again → confirm it runs normally
6. Trigger GH Actions kill-switch workflow (stop) → confirm same behavior as step 2
