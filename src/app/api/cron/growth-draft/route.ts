import { NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth.server";
import { runDraftStep } from "@/lib/growth/draft-run.server";
import { sendGrowthDigest } from "@/lib/growth/digest.server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const drafted = await runDraftStep(3);
    const digest = await sendGrowthDigest();
    return NextResponse.json({ ok: true, ...drafted, digest });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "growth-draft failed" }, { status: 500 });
  }
}
