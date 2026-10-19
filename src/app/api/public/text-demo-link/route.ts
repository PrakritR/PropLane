import { NextResponse } from "next/server";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { sendPlatformLeadText } from "@/lib/one-number/lead-send.server";
import { otpMessageBody, requestPhoneOtp, verifyPhoneOtp } from "@/lib/one-number/phone-otp.server";
import { publicBindPhoneKey } from "@/lib/one-number/public-bind.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
const HOUR = 60 * 60 * 1000;
/** The code proves the visitor holds the number; the demo link is texted only after it is entered. */
const DEMO_OTP_SUBJECT = "demo-link";
const INVALID = "Enter a valid phone number and confirm consent.";
const UNAVAILABLE = "We couldn't send the text. View the dashboard here instead.";

function respond(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readSmallBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new Error("body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); throw new Error("body"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("sec-fetch-site") === "cross-site") return respond({ error: "Request not allowed." }, 403);

  let body: unknown;
  try { body = await readSmallBody(request); } catch { return respond({ error: INVALID }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return respond({ error: INVALID }, 400);
  const { phone: rawPhone, consent, action, otp } = body as { phone?: unknown; consent?: unknown; action?: unknown; otp?: unknown };
  const phone = typeof rawPhone === "string" && rawPhone.length <= 40 && /^[+\d().\s-]+$/.test(rawPhone)
    ? normalizeE164(rawPhone) : null;
  const phoneKey = phone ? publicBindPhoneKey(phone) : null;
  const verifying = action === "verify";
  if (!phone || !phoneKey || (verifying ? typeof otp !== "string" || otp.length > 12 : consent !== true)) {
    return respond({ error: INVALID }, 400);
  }

  const ip = clientIpFrom(request);
  const refused = (allowed: { ok: boolean; unavailable?: true }) =>
    allowed.ok ? null : respond({ error: allowed.unavailable ? UNAVAILABLE : "Please try again later, or view the dashboard here." }, allowed.unavailable ? 503 : 429);

  try {
    const db = createSupabaseServiceRoleClient();
    if (verifying) {
      // Wrong guesses are bounded by the code's own five tries and the phone's 24-hour failure cap.
      const gated = refused(await rateLimit(`text-demo:verify-ip:${ip}`, 30, HOUR));
      if (gated) return gated;
      const checked = await verifyPhoneOtp(db, { phoneKey, purpose: "public_bind", subjectId: DEMO_OTP_SUBJECT, code: otp });
      if (!checked.ok) {
        return checked.reason === "locked"
          ? respond({ error: "Please try again later, or view the dashboard here." }, 429)
          : respond({ error: "That code did not work." }, 400);
      }
      // The visitor now holds the number. Only a real link send spends the shared hourly budget:
      // invalid input, a wrong code or a throttled caller never reaches this line.
      for (const [key, limit] of [[`text-demo:phone:${phone}`, 1], ["text-demo:global", 50]] as const) {
        const gate = refused(await rateLimit(key, limit, HOUR));
        if (gate) return gate;
      }
      const result = await sendPlatformLeadText(db, {
        to: phone,
        purpose: "requested_demo_link",
        body: `PropLane: Here is your link: ${PRODUCTION_APP_ORIGIN}/#dashboard Reply STOP to opt out.`,
      });
      if (!result.ok) return result.reason === "delivery_unknown"
        ? respond({ error: "Delivery isn't confirmed. Check your phone or view the dashboard.", deliveryUnknown: true }, 503)
        : respond({ error: UNAVAILABLE }, 503);
      return respond({ ok: true });
    }

    // Step one: text a code containing nothing but the code. Per IP and per phone first.
    for (const [key, limit] of [[`text-demo:send-ip:${ip}`, 5], [`text-demo:code-phone:${phone}`, 3]] as const) {
      const gate = refused(await rateLimit(key, limit, HOUR));
      if (gate) return gate;
    }
    // The existing platform sender retains its own consent gate. This read also
    // makes a consent-store outage fail closed for this public, paid side effect.
    const suppression = await readSmsSuppressionState(db, phone);
    if (!suppression.ok || suppression.optedOut) return respond({ error: UNAVAILABLE }, 503);
    const gate = refused(await rateLimit("text-demo:code-global", 100, HOUR));
    if (gate) return gate;
    let unknown = false;
    const sent = await requestPhoneOtp(db, {
      phoneKey, purpose: "public_bind", subjectId: DEMO_OTP_SUBJECT,
      send: async (code) => {
        const result = await sendPlatformLeadText(db, { to: phone, purpose: "requested_demo_link", body: otpMessageBody(code) });
        if (!result.ok && result.reason === "delivery_unknown") unknown = true;
        return result.ok;
      },
    });
    if (sent.ok) return respond({ ok: true, codeSent: true });
    if (sent.reason === "rate_limited") return respond({ error: "Please try again later, or view the dashboard here." }, 429);
    return unknown
      ? respond({ error: "Delivery isn't confirmed. Check your phone or view the dashboard.", deliveryUnknown: true }, 503)
      : respond({ error: UNAVAILABLE }, 503);
  } catch {
    return respond({ error: UNAVAILABLE }, 503);
  }
}
