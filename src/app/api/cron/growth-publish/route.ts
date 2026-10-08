import { NextResponse } from "next/server";
import { runPublishTick } from "@/lib/growth/publish.server";
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
  // The log driver fakes publishing; never run it in production, even when explicitly configured.
  if (process.env.VERCEL_ENV === "production" && process.env.GROWTH_PUBLISHER?.trim() === "log") {
    return NextResponse.json({ ok: false, error: "GROWTH_PUBLISHER=log is not allowed in production" }, { status: 503 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runPublishTick(new Date())) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "growth-publish failed" }, { status: 500 });
  }
}
