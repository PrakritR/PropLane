import { NextResponse } from "next/server";
import { validateTwilioVoiceWebhook } from "@/lib/twilio-voice.server";

export const runtime = "nodejs";

/** Best-effort recording status callback — logs only in V1. */
export async function POST(req: Request) {
  const raw = await req.text();
  const validated = validateTwilioVoiceWebhook(req, raw);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.message }, { status: validated.status });
  }
  console.info("twilio voice recording callback", {
    callSid: validated.params.CallSid,
    recordingSid: validated.params.RecordingSid,
    status: validated.params.RecordingStatus,
  });
  return NextResponse.json({ ok: true });
}
