import { NextResponse } from "next/server";
import { Webhook } from "standardwebhooks";
import { claimPhoneAuthHookDelivery, sendPhoneAuthCode } from "@/lib/auth/phone-otp-delivery.server";
import { SHARED_LINE_OTP_RULES } from "@/lib/one-number/contracts";
import { normalizeE164 } from "@/lib/phone-e164";

export const runtime = "nodejs";

const FAILURE_MESSAGE = "Unable to send verification code.";

function failure(status: number) {
  return NextResponse.json({ error: { http_code: status, message: FAILURE_MESSAGE } }, { status });
}

/** Supabase Send SMS HTTP hook: signature verification always precedes parsing and delivery. */
export async function POST(request: Request) {
  const secret = process.env.SUPABASE_SEND_SMS_HOOK_SECRET?.trim();
  if (!secret) return failure(503);

  let payload: unknown;
  try {
    const rawBody = await request.text();
    // Supabase supplies v1,whsec_<base64>; the library accepts whsec_<base64>.
    // Standard Webhooks also checks the signed timestamp (five-minute tolerance).
    payload = new Webhook(secret.replace(/^v1,/, "")).verify(rawBody, {
      "webhook-id": request.headers.get("webhook-id") ?? "",
      "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
      "webhook-signature": request.headers.get("webhook-signature") ?? "",
    });
  } catch {
    return failure(401);
  }

  if (!payload || typeof payload !== "object") return failure(400);
  const { user, sms } = payload as { user?: unknown; sms?: unknown };
  if (!user || typeof user !== "object" || !sms || typeof sms !== "object") return failure(400);
  const { phone, id } = user as { phone?: unknown; id?: unknown };
  const { otp } = sms as { otp?: unknown };
  // GoTrue may serialize an E.164 phone without its leading + (including non-US phones).
  const normalizedPhone = typeof phone === "string"
    ? normalizeE164(phone.startsWith("+") ? phone : `+${phone}`)
    : null;
  if (
    typeof phone !== "string" || !/^\+?[1-9]\d{7,14}$/.test(phone) || !normalizedPhone ||
    typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    typeof otp !== "string" || !new RegExp(`^\\d{${SHARED_LINE_OTP_RULES.codeLength}}$`).test(otp)
  ) return failure(400);

  try {
    if (!(await claimPhoneAuthHookDelivery(normalizedPhone))) return failure(429);
    if (!(await sendPhoneAuthCode(normalizedPhone, otp, id))) return failure(503);
    return NextResponse.json({});
  } catch {
    return failure(503);
  }
}
