/**
 * /app/api/health/route.js
 *
 * Simple health-check endpoint. Useful for:
 *  - Verifying the deployment is live after a deploy
 *  - Uptime monitors / status pages
 *  - Quick sanity checks during local development
 *
 * Returns HTTP 200 with { status: "ok" } when the app is running.
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ status: "ok" });
}
