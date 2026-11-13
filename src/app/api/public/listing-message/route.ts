import { NextResponse } from "next/server";
import { readPhoneIdentity } from "@/lib/auth/phone-auth.server";
import { sendListingMessageCode, verifyAndSendListingMessage, type SessionPhone } from "@/lib/listing-message/send.server";
import { parseListingMessageRequest } from "@/lib/listing-message/model";
import { resolveListingTextUsCode } from "@/lib/listing-message/text-us-code.server";
import { getPublicTextingConfig } from "@/lib/marketing/public-texting.server";
import { publicBindPhoneKey } from "@/lib/one-number/public-bind.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { phoneRateKey } from "@/lib/sms/phone-key";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;
const NO_STORE = { "Cache-Control": "no-store" };
const TOO_MANY = { error: "Too many tries. Try again later." };

/** Texts here are billed to the home's workspace, so the caps on SENDING are the tight ones. */
const SEND_PER_IP_PER_HOUR = 8;
const SEND_PER_PHONE_PER_HOUR = 4;
const SEND_PER_PROPERTY_PER_HOUR = 60;
const VERIFY_PER_IP_PER_HOUR = 30;
const VERIFY_PER_PHONE_PER_HOUR = 15;

/**
 * The signed-in visitor's own VERIFIED phone, or null. A signed-out visitor, a failed read and an account with no
 * verified phone all read the same (null): the code step then runs, so nothing is skipped on a guess.
 */
async function sessionVerifiedPhone(): Promise<SessionPhone> {
  try {
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) return null;
    const identity = await readPhoneIdentity(createSupabaseServiceRoleClient(), user.id);
    return identity.verified ? identity.phone : null;
  } catch {
    return null;
  }
}

/**
 * Message a home, or one room of it, with no account (design-1112 §1).
 *
 *   { action: "send_code",   propertyId, roomId?, phone, body }            text a code to the phone typed
 *   { action: "verify_send", propertyId, roomId?, phone, body, otp, name? } check it, store the message
 *
 * The phone is what the visitor typed, so the code proves they hold it and nothing more. The home, its workspace and
 * its owner are re-derived from the database; the message is stored exactly as typed through the prospect spine, with
 * the home and room as the stamp on the conversation. Nothing here reads or answers whether the number already has an
 * account: every outcome is the same for a known and an unknown phone.
 */
export async function POST(req: Request) {
  const parsed = parseListingMessageRequest(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const request = parsed.value;
  const sending = request.action === "send_code";

  const ip = clientIpFrom(req);
  const byIp = await rateLimit(`listing-message-${sending ? "send" : "verify"}-ip:${ip}`, sending ? SEND_PER_IP_PER_HOUR : VERIFY_PER_IP_PER_HOUR, HOUR_MS);
  if (!byIp.ok) return NextResponse.json(TOO_MANY, { status: 429, headers: NO_STORE });

  const phoneKey = publicBindPhoneKey(request.phone);
  if (!phoneKey) return NextResponse.json({ error: "Enter a US phone number." }, { status: 400, headers: NO_STORE });
  const phoneBucket = phoneRateKey(phoneKey);
  const byPhone = await rateLimit(`listing-message-${sending ? "send" : "verify"}-phone:${phoneBucket}`, sending ? SEND_PER_PHONE_PER_HOUR : VERIFY_PER_PHONE_PER_HOUR, HOUR_MS);
  if (!byPhone.ok) return NextResponse.json(TOO_MANY, { status: 429, headers: NO_STORE });
  if (sending) {
    const byProperty = await rateLimit(`listing-message-send-property:${request.propertyId}`, SEND_PER_PROPERTY_PER_HOUR, HOUR_MS);
    if (!byProperty.ok) return NextResponse.json(TOO_MANY, { status: 429, headers: NO_STORE });
  }

  const db = createSupabaseServiceRoleClient();
  const sessionPhone = await sessionVerifiedPhone();
  const outcome = sending
    ? await sendListingMessageCode(db, request, { sessionPhone })
    : await verifyAndSendListingMessage(db, request, { sessionPhone });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error, ...(outcome.needsNewCode ? { needsNewCode: true } : {}) }, { status: outcome.status, headers: NO_STORE });
  }
  return NextResponse.json(
    { ok: true, ...(outcome.skipCode ? { skipCode: true } : {}), ...(outcome.accountUrl ? { accountUrl: outcome.accountUrl } : {}) },
    { headers: NO_STORE },
  );
}

/**
 * `GET ?propertyId=` → `{ textCode }`: the entry code the listing's "Text us" body carries. A public read about a public
 * listing that is identical for everyone, so it is CDN-cacheable; only the PropLane line's configured number gates it.
 */
export async function GET(req: Request) {
  const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim() ?? "";
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(propertyId)) {
    return NextResponse.json({ textCode: null }, { headers: NO_STORE });
  }
  const limited = await rateLimit(`listing-message-code-ip:${clientIpFrom(req)}`, 120, HOUR_MS);
  if (!limited.ok) return NextResponse.json(TOO_MANY, { status: 429, headers: NO_STORE });
  const config = await getPublicTextingConfig().catch(() => null);
  if (!config?.phone) return NextResponse.json({ textCode: null }, { headers: NO_STORE });
  const textCode = await resolveListingTextUsCode(createSupabaseServiceRoleClient(), propertyId).catch(() => null);
  return NextResponse.json(
    { textCode },
    { headers: { "Cache-Control": textCode ? "public, s-maxage=300, stale-while-revalidate=600" : "public, s-maxage=30" } },
  );
}
