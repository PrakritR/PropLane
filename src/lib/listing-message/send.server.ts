import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { roleForLinkPurpose, sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { otpMessageBody, requestPhoneOtp, verifyPhoneOtp } from "@/lib/one-number/phone-otp.server";
import { publicBindPhoneKey } from "@/lib/one-number/public-bind.server";
import { mintPersonalAccountLink } from "@/lib/personal-link/index.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { recordInbound } from "@/lib/prospect-spine/index.server";
import { recordOptIn } from "@/lib/sms-consent";
import { loadMessageListing, type MessageListing } from "./listing.server";
import type { ListingMessageRequest } from "./model";

export type ListingMessageOutcome =
  | { ok: true; skipCode?: true; accountUrl?: string | null }
  | { ok: false; status: 400 | 404 | 429 | 502 | 503; error: string; needsNewCode?: true };

/** The answers a caller may see. Deliberately blind to whether the number already has an account or is known to PropLane. */
const NOT_AVAILABLE = "This listing is not available.";
const BAD_PHONE = "Enter a US phone number.";
const SEND_FAILED = "We could not text that number. Check it and try again.";
const BAD_CODE = "That code did not work.";

/**
 * A signed-in visitor's own verified phone (never the typed one): when the typed number IS it, the session already
 * proved the phone and the code step is skipped. The route resolves it; null for a signed-out visitor.
 */
export type SessionPhone = string | null;

async function resolveListing(db: SupabaseClient, req: ListingMessageRequest): Promise<{ ok: true; listing: MessageListing } | { ok: false; outcome: ListingMessageOutcome }> {
  const loaded = await loadMessageListing(db, { propertyId: req.propertyId, roomId: req.roomId });
  if (loaded.ok) return loaded;
  return {
    ok: false,
    outcome: loaded.reason === "room_not_found"
      ? { ok: false, status: 400, error: "That room is not on this listing." }
      : { ok: false, status: 404, error: NOT_AVAILABLE },
  };
}

function sessionProvesPhone(sessionPhone: SessionPhone, phoneKey: string): boolean {
  const typed = normalizeE164(phoneKey);
  return Boolean(typed && sessionPhone && normalizeE164(sessionPhone) === typed);
}

/** Step 1: text a six-digit code to the number typed (or skip it for a signed-in visitor's own verified number). */
export async function sendListingMessageCode(
  db: SupabaseClient,
  req: ListingMessageRequest,
  opts: { sessionPhone: SessionPhone },
): Promise<ListingMessageOutcome> {
  const phoneKey = publicBindPhoneKey(req.phone);
  if (!phoneKey) return { ok: false, status: 400, error: BAD_PHONE };
  const found = await resolveListing(db, req);
  if (!found.ok) return found.outcome;
  if (sessionProvesPhone(opts.sessionPhone, phoneKey)) return { ok: true, skipCode: true };

  const { listing } = found;
  const sent = await requestPhoneOtp(db, {
    phoneKey,
    purpose: "listing_message",
    subjectId: listing.propertyId,
    send: (code, challengeId) =>
      sendWorkspacePhoneText(db, {
        workspaceId: listing.workspaceId,
        phoneKey,
        body: otpMessageBody(code),
        role: roleForLinkPurpose("public_tour"),
        idempotencyKey: `phone-code:${challengeId}`,
        basis: { kind: "code" },
      }),
  });
  if (sent.ok) return { ok: true };
  if (sent.reason === "rate_limited") return { ok: false, status: 429, error: "Too many codes were sent to this number. Try again in an hour." };
  return { ok: false, status: sent.reason === "unavailable" ? 503 : 502, error: SEND_FAILED };
}

/**
 * Step 2: check the code, then store the message. The message goes through the prospect spine exactly as typed (the home
 * and room are the stamp on the conversation, never injected into the text), as a VERIFIED phone identity: no account,
 * no `auth.users` row, no email. Consent to be texted back is recorded at send. The personal account link is a
 * courtesy: a failure to mint it never fails the message.
 */
export async function verifyAndSendListingMessage(
  db: SupabaseClient,
  req: ListingMessageRequest,
  opts: { sessionPhone: SessionPhone; now?: Date },
): Promise<ListingMessageOutcome> {
  const phoneKey = publicBindPhoneKey(req.phone);
  if (!phoneKey) return { ok: false, status: 400, error: BAD_PHONE };
  const phoneE164 = normalizeE164(phoneKey);
  if (!phoneE164) return { ok: false, status: 400, error: BAD_PHONE };
  const found = await resolveListing(db, req);
  if (!found.ok) return found.outcome;
  const { listing } = found;
  const now = opts.now ?? new Date();

  if (!sessionProvesPhone(opts.sessionPhone, phoneKey)) {
    const verified = await verifyPhoneOtp(db, { phoneKey, purpose: "listing_message", subjectId: listing.propertyId, code: req.otp, now });
    if (!verified.ok) {
      if (verified.reason === "locked") return { ok: false, status: 429, error: "Too many wrong codes. Ask for a new code." };
      return { ok: false, status: 400, error: BAD_CODE };
    }
  }

  await recordOptIn(db, phoneKey, null, "listing-message");
  const recorded = await recordInbound(db, {
    workspaceId: listing.workspaceId,
    ownerUserId: listing.ownerUserId,
    identity: { kind: "phone", phoneE164, verified: true, displayName: req.name },
    context: {
      propertyId: listing.propertyId,
      roomId: listing.roomId,
      roomLabel: listing.roomLabel,
      source: "listing_message",
    },
    body: req.body,
    channel: "in_app",
    eventId: `web:${randomUUID()}`,
    occurredAt: now.toISOString(),
  }).catch(() => null);
  if (!recorded || !recorded.ok) {
    // The code is single-use and already spent: the visitor asks for a new one.
    return { ok: false, status: 503, error: "We could not send that just now. Ask for a new code and try again.", needsNewCode: true };
  }

  const accountUrl = await mintPersonalAccountLink(db, {
    phoneE164,
    workspaceId: listing.workspaceId,
    propertyId: listing.propertyId,
  }).catch(() => null);
  return { ok: true, accountUrl };
}
