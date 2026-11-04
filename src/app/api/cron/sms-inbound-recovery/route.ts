import { recoverInboundEnvelopes, smsEnvelopeRuntime } from "@/lib/sms/inbound-envelope.server";
import { processAcceptedInbound } from "@/lib/sms/process-accepted-inbound.server";
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
    const db = createSupabaseServiceRoleClient();
    const deadline = Date.now() + START_DEADLINE_MS;
    const { error: capsuleCleanupError } = await db.rpc("sms_ingress_purge_expired_quote_capsules", {
      p_runtime: smsEnvelopeRuntime(), p_account: process.env.TWILIO_ACCOUNT_SID?.trim() ?? "",
    });
    if (capsuleCleanupError) throw new Error("Quote capsule cleanup unavailable");
    const envelopes = await recoverInboundEnvelopes(db, { process: processAcceptedInbound, deadline });
    const result = await recoverInboundReceipts(db, { deadline });
    const { error: retentionError } = await db.rpc("purge_sms_ingress_retention");
    if (retentionError) throw new Error("SMS ingress retention unavailable");
    if (result.failed > 0 || result.dropped > 0) console.warn("sms inbound recovery", result);
    const ok = result.failed === 0 && envelopes.needsReview === 0;
    if (envelopes.needsReview) console.warn("sms ingress needs review", envelopes);
    return NextResponse.json({ ok, ...result, envelopes }, { status: ok ? 200 : 503 });
  } catch (error) {
    console.error("sms inbound recovery failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Inbound SMS recovery failed." }, { status: 503 });
  }
}
