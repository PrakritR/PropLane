import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { durableProspectSmsHealth } from "@/lib/sms/prospect-sms-burst.server";
import { runProspectSmsBurstJob } from "@/lib/sms/prospect-sms-burst-job.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

function validCallbackSecret(got: string | null): boolean {
  const expected = process.env.PROSPECT_SMS_BURST_CALLBACK_SECRET?.trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected); const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** QStash gets only the opaque burst id/revision. All routing identity and text
 * are loaded from service-only rows, and a forwarded per-job secret prevents a
 * caller from forging a worker invocation. */
export async function POST(req: Request) {
  const health = durableProspectSmsHealth();
  if (!health.ok) return NextResponse.json({ error: health.error }, { status: 503 });
  const raw = await req.text();
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  const signature = req.headers.get("upstash-signature")?.trim();
  if (!currentSigningKey || !nextSigningKey || !signature || !validCallbackSecret(req.headers.get("x-prospect-sms-burst-secret"))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  let verified = false;
  try {
    verified = await new Receiver({ currentSigningKey, nextSigningKey }).verify({ signature, body: raw, url: req.url });
  } catch {
    verified = false;
  }
  if (!verified) return NextResponse.json({ error: "Invalid queue signature." }, { status: 401 });
  const payload = JSON.parse(raw) as { burstId?: unknown; revision?: unknown } | null;
  const burstId = typeof payload?.burstId === "string" ? payload.burstId : "";
  const revision = typeof payload?.revision === "number" ? payload.revision : NaN;
  if (!burstId || !Number.isSafeInteger(revision)) return NextResponse.json({ error: "Invalid job." }, { status: 400 });
  return runProspectSmsBurstJob(createSupabaseServiceRoleClient(), burstId, revision);
}
