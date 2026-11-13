import { NextResponse } from "next/server";
import { twimlResponse, twimlSay, validateTwilioVoiceWebhook } from "@/lib/twilio-voice.server";

export const runtime = "nodejs";

const WHO: Record<string, string> = { prospect: "a prospect", resident: "a resident", manager: "a manager" };

/**
 * Played to the person who answers an escalated call, before the caller is connected: who is on the line. The kind comes from
 * our own URL (Twilio signs it), is one of three words, and is never free text from a caller.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const validated = validateTwilioVoiceWebhook(req, raw);
  if (!validated.ok) return NextResponse.json({ error: validated.message }, { status: validated.status });
  const kind = new URL(req.url).searchParams.get("kind") ?? "";
  return twimlResponse(twimlSay(`PropLane call from ${WHO[kind] ?? "a caller"}. Connecting you now.`));
}
