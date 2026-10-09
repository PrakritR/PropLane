import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { runInsightsTick } from "@/lib/growth/insights.server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runInsightsTick()) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "growth-insights failed" }, { status: 500 });
  }
}
