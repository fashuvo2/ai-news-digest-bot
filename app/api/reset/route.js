/**
 * /app/api/reset/route.js
 *
 * Clears the "seen" deduplication keys in Redis so the next digest run
 * will treat recently published articles as new.
 *
 * POST /api/reset
 *   Body (optional JSON): { "ns": "ai" | "tech" }
 *   Omit "ns" to reset both namespaces.
 *
 * Protected by the same CRON_SECRET as the digest endpoints.
 */

import { NextResponse } from "next/server";
import { resetSeen } from "@/lib/storage";

function isAuthorised(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let ns = null;
  try {
    const body = await request.json().catch(() => ({}));
    if (body.ns === "ai" || body.ns === "tech") ns = body.ns;
  } catch {
    // no body — reset both namespaces
  }

  const namespaces = ns ? [ns] : ["ai", "tech"];
  const results = {};

  for (const namespace of namespaces) {
    results[namespace] = await resetSeen(namespace);
  }

  return NextResponse.json({ status: "ok", deleted: results });
}
