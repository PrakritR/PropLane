import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { runPublishTick } from "@/lib/growth/publish.server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
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
