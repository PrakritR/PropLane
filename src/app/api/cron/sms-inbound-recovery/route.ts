import { NextResponse } from "next/server";
import { recoverInboundReceipts } from "@/lib/sms/inbound-pipeline.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 300;

// A recovered text can run a full agent turn (~60s). Start none after this so
// no run is killed at maxDuration holding a live receipt lease.
const START_DEADLINE_MS = 200_000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const result = await recoverInboundReceipts(createSupabaseServiceRoleClient(), {
      deadline: Date.now() + START_DEADLINE_MS,
    });
    if (result.failed > 0 || result.dropped > 0) console.warn("sms inbound recovery", result);
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed === 0 ? 200 : 503 });
  } catch (error) {
    console.error("sms inbound recovery failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Inbound SMS recovery failed." }, { status: 503 });
  }
}
