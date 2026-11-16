import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { roleForLinkPurpose, sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { mintPhoneBoundLink, PhoneBoundLinkError } from "@/lib/one-number/links.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { rateLimit } from "@/lib/rate-limit";
import { hashGuestDraftToken, isWellFormedGuestDraftToken } from "@/lib/rental-application/guest-draft.server";
import { phoneRateKey } from "@/lib/sms/phone-key";
import { loadGuestTourListing } from "@/lib/tour-guest-prospect.server";
import { loadTourInquiryById } from "@/lib/tour-resident-link.server";
import {
  GUEST_SIGNUP_LINK_TTL_MS,
  guestSignupTargetId,
  guestSignupTargetType,
  guestSignupTextBody,
} from "./model";

export const GUEST_LINKS_PER_PHONE_PER_HOUR = 3;
export const GUEST_LINKS_PER_SUBJECT_PER_HOUR = 5;
/** A tour inquiry has no proof it came from the same browser, so one workspace's tour links are capped as a whole. */
export const GUEST_TOUR_LINKS_PER_WORKSPACE_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

export type GuestSignupSendInput =
  | { kind: "apply"; draftToken: unknown }
  | { kind: "tour"; tourInquiryId: unknown };

export type GuestSignupSendResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 429 | 502 | 503; error: string };

const UNAVAILABLE = "We could not text that number. Use a code or email instead.";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * Text a guest the single-use sign-in link. The destination phone is NEVER in the request: it is the phone the renter
 * already typed on the held application (`guest_application_drafts.phone_e164`, found by the unguessable draft token)
 * or on the guest tour request they just filed (the inquiry's own phone, and only when they ticked the SMS box). The
 * home is re-derived from the database. The text is a control message the person just asked for, so STOP still wins and
 * no consent grant is invented; it goes from the line of the workspace the home belongs to.
 */
export async function sendGuestSignupLink(db: SupabaseClient, input: GuestSignupSendInput): Promise<GuestSignupSendResult> {
  let phone: string | null = null;
  let subjectId = "";
  let propertyId = "";
  if (input.kind === "apply") {
    if (!isWellFormedGuestDraftToken(input.draftToken)) return { ok: false, status: 400, error: UNAVAILABLE };
    const { data, error } = await db
      .from("guest_application_drafts")
      .select("property_id, phone_e164, expires_at")
      .eq("token_hash", hashGuestDraftToken(input.draftToken))
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) return { ok: false, status: 503, error: UNAVAILABLE };
    const row = (data ?? null) as Record<string, unknown> | null;
    phone = row ? normalizeE164(text(row.phone_e164)) : null;
    propertyId = row ? text(row.property_id) : "";
    subjectId = propertyId;
  } else {
    const inquiryId = text(input.tourInquiryId);
    if (!inquiryId || inquiryId.length > 120) return { ok: false, status: 400, error: UNAVAILABLE };
    const inquiry = await loadTourInquiryById(db, inquiryId).catch(() => null);
    // A guest tour only (server-owned flag), and only when the renter agreed to be texted.
    if (!inquiry || inquiry.guestTour !== true || inquiry.smsConsent !== true) return { ok: false, status: 404, error: UNAVAILABLE };
    phone = normalizeE164(text(inquiry.phone));
    propertyId = text(inquiry.propertyId);
    subjectId = inquiryId;
  }
  if (!phone || !propertyId || !subjectId) return { ok: false, status: 404, error: UNAVAILABLE };

  const listing = await loadGuestTourListing(db, propertyId);
  if (!listing) return { ok: false, status: 404, error: UNAVAILABLE };

  const keys = [
    [`guest-signup-link-phone:${phoneRateKey(phone)}`, GUEST_LINKS_PER_PHONE_PER_HOUR],
    [`guest-signup-link-subject:${hashGuestDraftToken(subjectId).slice(0, 32)}`, GUEST_LINKS_PER_SUBJECT_PER_HOUR],
    ...(input.kind === "tour"
      ? ([[`guest-signup-link-tour-ws:${hashGuestDraftToken(listing.workspaceId).slice(0, 32)}`, GUEST_TOUR_LINKS_PER_WORKSPACE_PER_HOUR]] as const)
      : []),
  ] as const;
  for (const [key, max] of keys) {
    if (!(await rateLimit(key, max, HOUR_MS)).ok) return { ok: false, status: 429, error: "Too many links were sent. Try again in an hour." };
  }

  let minted: Awaited<ReturnType<typeof mintPhoneBoundLink>>;
  try {
    minted = await mintPhoneBoundLink(db, {
      phoneKey: phone,
      workspaceId: listing.workspaceId,
      purpose: "account",
      targetType: guestSignupTargetType(input.kind),
      targetId: guestSignupTargetId(listing.workspaceId, subjectId),
      ttlMs: GUEST_SIGNUP_LINK_TTL_MS,
    });
  } catch (error) {
    if (error instanceof PhoneBoundLinkError && error.code === "rate_limited") return { ok: false, status: 429, error: "Too many links were sent. Try again in an hour." };
    return { ok: false, status: 503, error: UNAVAILABLE };
  }

  const sent = await sendWorkspacePhoneText(db, {
    workspaceId: listing.workspaceId,
    phoneKey: phone,
    body: guestSignupTextBody(input.kind, listing.propertyLabel, minted.url),
    role: roleForLinkPurpose(input.kind === "tour" ? "public_tour" : "public_apply"),
    idempotencyKey: `guest-signup-link:${minted.linkId}`,
    basis: { kind: "code" },
  }).catch(() => false);
  if (!sent) {
    // A link nobody received is not left live.
    await db.from("phone_bound_links").update({ revoked_at: new Date().toISOString() }).eq("id", minted.linkId).then(() => undefined, () => undefined);
    return { ok: false, status: 502, error: UNAVAILABLE };
  }
  return { ok: true };
}
