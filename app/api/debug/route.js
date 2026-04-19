/**
 * /app/api/debug/route.js
 * Shows per-feed fetch results for diagnosing which sources are working.
 * Protected by the same CRON_SECRET. Does NOT send anything to Telegram.
 */

import { NextResponse } from "next/server";
import Parser from "rss-parser";
import SOURCES from "@/lib/sources";

const parser = new Parser({ timeout: 15_000 });

function isAuthorised(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1_000);

  const results = await Promise.allSettled(
    SOURCES.map(async (source) => {
      try {
        const feed = await parser.parseURL(source.url);
        const recent = feed.items.filter((item) => {
          const d = new Date(item.isoDate || item.pubDate);
          return d >= cutoff;
        });
        return {
          name: source.name,
          status: "ok",
          total_items: feed.items.length,
          recent_items: recent.length,
        };
      } catch (err) {
        return {
          name: source.name,
          status: "error",
          error: err.message,
        };
      }
    })
  );

  const report = results.map((r) =>
    r.status === "fulfilled" ? r.value : { status: "error", error: r.reason }
  );

  return NextResponse.json({ feeds: report });
}
