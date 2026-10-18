import { NextResponse } from "next/server";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { sendPlatformLeadText } from "@/lib/one-number/lead-send.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
const HOUR = 60 * 60 * 1000;
const UNAVAILABLE = "We couldn't send the text. Open the demo here instead.";

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
  try { body = await readSmallBody(request); } catch { return respond({ error: "Enter a valid phone number and confirm consent." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return respond({ error: "Enter a valid phone number and confirm consent." }, 400);
  const { phone: rawPhone, consent } = body as { phone?: unknown; consent?: unknown };
  const phone = typeof rawPhone === "string" && rawPhone.length <= 40 && /^[+\d().\s-]+$/.test(rawPhone)
    ? normalizeE164(rawPhone) : null;
  if (!phone || consent !== true) return respond({ error: "Enter a valid phone number and confirm consent." }, 400);

  try {
    // Each dimension is shared across deployed instances; no captcha or account
    // is needed. Reserve before any send, including provider refusals/retries.
    for (const [key, limit] of [
      [`text-demo:ip:${clientIpFrom(request)}`, 5],
      [`text-demo:phone:${phone}`, 1],
      ["text-demo:global", 50],
    ] as const) {
      const allowed = await rateLimit(key, limit, HOUR);
      if (!allowed.ok) return respond({ error: allowed.unavailable ? UNAVAILABLE : "Please try again later, or open the demo here." }, allowed.unavailable ? 503 : 429);
    }
    const db = createSupabaseServiceRoleClient();
    // The existing platform sender retains its own consent gate. This read also
    // makes a consent-store outage fail closed for this public, paid side effect.
    const suppression = await readSmsSuppressionState(db, phone);
    if (!suppression.ok || suppression.optedOut) return respond({ error: UNAVAILABLE }, 503);
    const result = await sendPlatformLeadText(db, {
      to: phone,
      purpose: "requested_demo_link",
      body: `PropLane: Your demo is ready: ${PRODUCTION_APP_ORIGIN}/?demo=open Reply DEMO to try it by text. Reply STOP to opt out.`,
    });
    if (!result.ok) return result.reason === "delivery_unknown"
      ? respond({ error: "Delivery isn't confirmed. Check your phone or open the demo.", deliveryUnknown: true }, 503)
      : respond({ error: UNAVAILABLE }, 503);
    return respond({ ok: true });
  } catch {
    return respond({ error: UNAVAILABLE }, 503);
  }
}
