import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";
import { validateTwilioVoiceWebhook } from "@/lib/twilio-voice.server";

export const runtime = "nodejs";

/** Signed recording callback settles only its own reserved duration. */
export async function POST(req: Request) {
  const raw = await req.text();
  const validated = validateTwilioVoiceWebhook(req, raw);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.message }, { status: validated.status });
  }
  const callSid = String(validated.params.CallSid ?? "");
  const status = validated.params.RecordingStatus;
  if (status !== "completed" && status !== "absent" && status !== "failed") return NextResponse.json({ ok: true });
  const seconds = status === "completed" ? Number(validated.params.RecordingDuration) : 0;
  if (!callSid || !Number.isFinite(seconds) || seconds < 0) return NextResponse.json({ error: "Invalid recording." }, { status: 400 });
  const db = createSupabaseServiceRoleClient();
  const key = `voice_recording_minute:${callSid}`;
  const { data: usage, error: readError } = await db.from("manager_comms_usage_events").select("manager_user_id").eq("idempotency_key", key).maybeSingle();
  if (readError) return NextResponse.json({ error: "Recording credit unavailable." }, { status: 503 });
  if (usage) {
    const { error } = await db.rpc("settle_comms_credit_quantity", { p_owner: usage.manager_user_id, p_key: key, p_quantity: Math.ceil(seconds / 60) });
    if (error) return NextResponse.json({ error: "Recording credit settlement unavailable." }, { status: 503 });
    const { maybeNotifyCommsBudgetThreshold } = await import("@/lib/comms-billing/notifications.server");
    await maybeNotifyCommsBudgetThreshold(db, usage.manager_user_id).catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}
