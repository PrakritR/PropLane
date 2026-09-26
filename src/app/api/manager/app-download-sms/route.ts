import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendSms } from "@/lib/twilio";
import { iosAppDownloadUrl } from "@/lib/ios-app-download";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * N068: a desktop viewer of the App tab has no fast way to get the PropLane
 * download link onto their phone besides the QR code. This texts the SAME
 * fixed download URL the QR code and App Store badge already point at — the
 * body is never caller-controlled, only the destination phone is, so this
 * can't be used to blast arbitrary text. Signed-in only; a per-account
 * throttle (shared `rateLimit`, no new migration — the bucket store already
 * backs other routes) bounds how many texts one account can trigger.
 */
const SEND_LIMIT = 3;
const SEND_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: Request) {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const phone = normalizeE164((body as { phone?: unknown } | null)?.phone);
  if (!phone) {
    return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
  }

  const limit = await rateLimit(`app-download-sms:${user.id}`, SEND_LIMIT, SEND_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.unavailable ? "Could not send right now. Try again shortly." : "Too many texts sent. Try again later." },
      { status: limit.unavailable ? 503 : 429 },
    );
  }

  const fromNumber = process.env.TWILIO_DEFAULT_FROM?.trim() ?? "";
  if (!fromNumber) {
    return NextResponse.json({ error: "Texting isn't configured yet." }, { status: 503 });
  }

  const result = await sendSms(phone, `Get PropLane on your phone: ${iosAppDownloadUrl()}`, fromNumber, {
    actorUserId: user.id,
  });
  if (!result.sent) {
    return NextResponse.json({ error: "Could not send the text. Try again shortly." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
