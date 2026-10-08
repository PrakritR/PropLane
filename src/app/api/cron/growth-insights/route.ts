import { NextResponse } from "next/server";
import { runInsightsTick } from "@/lib/growth/insights.server";
import { isProductionRuntime } from "@/lib/server-env";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Preview deployments are public and hold real service-role credentials.
    // Secretless access is only a localhost/test convenience.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runInsightsTick()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "growth-insights failed" }, { status: 500 });
  }
}
