/**
 * /app/api/stop/route.js
 *
 * Emergency kill switch endpoint.
 *
 * POST { "action": "stop" }   — activates kill switch, clears all queues, sends Telegram confirmation
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

  try {
    if (action === "stop") {
      await setKillSwitch();
      await clearQueue("tech");
      await clearQueue("ai");
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
  } catch (err) {
    console.error("[stop] Unexpected error:", err);
    return NextResponse.json(
      { error: "Internal server error", detail: err.message },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const active = await getKillSwitch();
  return NextResponse.json({ active });
}
