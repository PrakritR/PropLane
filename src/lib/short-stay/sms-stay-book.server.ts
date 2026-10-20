import "server-only";

/**
 * Books the stay a texter picked and said YES to. It is the guest-portal booking path
 * (`bookGuestStays` -> `createShortStayRows`, the ONE core) with the guest's identity being the phone
 * that texted: the login is the one that phone provably owns (`ensureGuestLogin`), the row is stamped with
 * it and with `sms_short_stay`, and nothing in the text names who the guest is.
 *
 * Outcome: a returning guest on a listing that books them instantly is `confirmed` and gets the pay link
 * now; anyone else gets the 24-hour hold and the pay link the moment the host confirms
 * (`decideShortStayHold`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { rateLimit } from "@/lib/rate-limit";
import {
  SMS_CONFIRMATION_CANCELLED_REPLY,
  SMS_CONFIRMATION_LOCKED_REPLY,
  checkSmsConfirmationCode,
  clearSmsConfirmationCode,
  issueSmsConfirmationCode,
  readSmsConfirmationCode,
} from "@/lib/sms/confirmation-code";
import { bookGuestStays } from "@/lib/short-stay/guest-stays.server";
import { SHORT_STAY_HOLD_HOURS, payLinkSentence } from "@/lib/short-stay/guest-stays";
import { ensureGuestLogin } from "@/lib/short-stay/guest-login.server";
import type { StayOfferOption } from "@/lib/short-stay/sms-stay-offers.server";
import { mintStayPayLink } from "@/lib/short-stay/stay-pay-link.server";
import { loadShortStayListing } from "@/lib/short-stay-request.server";
import { formatShortStayMoney, shortStayRangeLabel } from "@/lib/short-stay-request";
import { normalizeE164 } from "@/lib/phone-e164";

/** Holds the SMS line may create for one room per day, and for one workspace per hour, whoever is texting. */
export const SMS_STAY_HOLDS_PER_LISTING_PER_DAY = 3;
export const SMS_STAY_HOLDS_PER_WORKSPACE_PER_HOUR = 6;

/**
 * Caller ID is not an identity (security review, Oct 20): anyone can send a text "from" a number, and a booking creates a
 * login for that number, a hold on a room and a pay link texted to it. So a stay is requested only when the sender repeats
 * the 4-digit code that was in the confirmation question, which went to the real phone. `bookStayForTexter` accepts only
 * this proof, which `confirmStayRequestCode` alone mints.
 */
export type StayRequestProof = { readonly offerId: string; readonly verified: true };

export type StayCodeResult =
  | { ok: true; proof: StayRequestProof }
  | { ok: false; error: "code_required" | "wrong_code" | "cancelled" | "locked" | "unavailable"; message: string };

/** The code for the offer the texter just picked, issued with the confirmation question. Null = no coded confirmation possible. */
export async function issueStayRequestCode(db: SupabaseClient, offerId: string): Promise<string | null> {
  return issueSmsConfirmationCode(db, { kind: "stay_request", subjectId: offerId, proposalId: offerId }).catch(() => null);
}

export function stayRequestCodedLine(code: string): string {
  return `Reply YES ${code} to request it.`;
}

/** The code the newest text carries ("YES 4821"), looking at each line of a burst, newest first. */
function codeFromInbound(text: string): string | null {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const code = readSmsConfirmationCode(line);
    if (code) return code;
  }
  return null;
}

/**
 * Check the texter's reply against the code issued for THIS offer. A bare YES costs no attempt and re-asks with a fresh
 * code; three wrong codes cancel the offer (and ten from one phone in a day stop the coded path for that phone).
 */
export async function confirmStayRequestCode(
  db: SupabaseClient,
  input: { offerId: string; text: string; phone: string },
): Promise<StayCodeResult> {
  const reask = async (lead: string): Promise<StayCodeResult> => {
    const fresh = await issueSmsConfirmationCode(db, { kind: "stay_request", subjectId: input.offerId }).catch(() => null);
    if (!fresh) return { ok: false, error: "unavailable", message: "I could not check that just now. Please try again in a moment." };
    return {
      ok: false,
      error: lead ? "wrong_code" : "code_required",
      message: `${lead}To request this stay, reply YES ${fresh}.`,
    };
  };
  const code = codeFromInbound(input.text);
  if (!code) return reask("");
  const checked = await checkSmsConfirmationCode(db, { kind: "stay_request", subjectId: input.offerId, code, phone: input.phone });
  if (checked === "ok") return { ok: true, proof: { offerId: input.offerId, verified: true } };
  if (checked === "locked") return { ok: false, error: "locked", message: SMS_CONFIRMATION_LOCKED_REPLY };
  if (checked === "exhausted") {
    await clearSmsConfirmationCode(db, { kind: "stay_request", subjectId: input.offerId });
    return { ok: false, error: "cancelled", message: SMS_CONFIRMATION_CANCELLED_REPLY };
  }
  if (checked === "unavailable") return { ok: false, error: "unavailable", message: "I could not check that code. Please try again in a moment." };
  return reask("That code did not match. ");
}

export type SmsStayBooking =
  | { ok: true; status: "hold" | "confirmed"; blockId: string; total: number; reply: string }
  | { ok: false; error: "bad_phone" | "rate_limited" | "not_confirmed" | "no_login" | "price_changed" | "unavailable" | "failed"; message: string; total?: number };

export async function bookStayForTexter(
  db: SupabaseClient,
  input: { option: StayOfferOption; phone: string; name?: string; now?: Date; offerId: string; proof: StayRequestProof | null | undefined },
): Promise<SmsStayBooking> {
  // Nothing is booked, and no login is made or linked for this number, without the code from the confirmation question.
  if (!input.proof || input.proof.verified !== true || input.proof.offerId !== input.offerId) {
    return { ok: false, error: "not_confirmed", message: "I need the confirmation code from my last text before I can request that." };
  }
  const phone = normalizeE164(input.phone);
  if (!phone) return { ok: false, error: "bad_phone", message: "We need the number you are texting from." };
  const { option } = input;
  if (!(await rateLimit(`sms-stay-phone:${phone}`, 5, 86_400_000)).ok) {
    return { ok: false, error: "rate_limited", message: "That is a lot of stay requests from this number today. Try again tomorrow." };
  }

  // The price is re-derived from the live listing, never taken from the quote: a rate changed since then is a new quote.
  const loaded = await loadShortStayListing(db, { propertyId: option.propertyId, roomId: option.roomId, guests: option.guests });
  if (!loaded.ok) return { ok: false, error: "unavailable", message: "That room is not available to book anymore." };
  const { listing } = loaded;
  const total = Math.round(listing.nightly * option.nights * 100) / 100;
  if (Math.abs(total - option.total) > 0.005) {
    return { ok: false, error: "price_changed", message: "The price changed since I quoted it.", total };
  }

  // Whoever is texting, one room takes a few SMS holds a day and one workspace a few an hour: a stranger cannot fill a
  // calendar or flood a host with requests from many numbers.
  if (!(await rateLimit(`sms-stay-listing:${option.propertyId}:${option.roomId}`, SMS_STAY_HOLDS_PER_LISTING_PER_DAY, 86_400_000)).ok) {
    return { ok: false, error: "rate_limited", message: "That room has had several requests today. Try other dates or another home, or book from the listing page." };
  }
  if (!(await rateLimit(`sms-stay-workspace:${listing.ownerId}`, SMS_STAY_HOLDS_PER_WORKSPACE_PER_HOUR, 3_600_000)).ok) {
    return { ok: false, error: "rate_limited", message: "That host has had several requests in the last hour. Try again later, or book from the listing page." };
  }

  const login = await ensureGuestLogin(db, { name: (input.name ?? "").trim(), phone }).catch(() => null);
  if (!login?.userId) return { ok: false, error: "no_login", message: "I could not set up a booking for this number." };

  const booked = await bookGuestStays(db, {
    userId: login.userId,
    body: {
      propertyId: option.propertyId,
      roomId: option.roomId,
      guests: option.guests,
      ranges: [{ checkIn: option.checkIn, checkOut: option.checkOut }],
      ...(option.arrival ? { estimatedArrival: option.arrival } : {}),
    },
    via: "sms",
    now: input.now,
  });
  if (!booked.ok) return { ok: false, error: "failed", message: booked.error };
  const result = booked.results[0];
  if (!result || result.outcome === "invalid" || result.outcome === "unavailable" || !result.stayId) {
    return {
      ok: false,
      error: result?.outcome === "unavailable" ? "unavailable" : "failed",
      message: result?.error ?? "Those nights are not available.",
    };
  }

  const where = `${option.roomLabel} at ${option.homeName}`;
  const range = shortStayRangeLabel(option.checkIn, option.checkOut).replace(/\s*–\s*/, " to ");
  const money = formatShortStayMoney(total);
  if (result.outcome === "confirmed") {
    const payUrl = await mintStayPayLink(db, { blockId: result.stayId, ownerId: listing.ownerId, propertyId: option.propertyId, phone });
    return {
      ok: true,
      status: "confirmed",
      blockId: result.stayId,
      total,
      reply: payUrl
        ? `Booked: ${where}, ${range}, ${money} total. ${payLinkSentence(total)} ${payUrl}`
        : `Booked: ${where}, ${range}, ${money} total. We will text you the payment link shortly.`,
    };
  }
  return {
    ok: true,
    status: "hold",
    blockId: result.stayId,
    total,
    reply: `Request sent: ${where}, ${range}, ${money} total. The host has ${SHORT_STAY_HOLD_HOURS} hours to confirm. The moment they do, I text you a link to pay ${money} right on the page (card, Apple Pay, Google Pay or bank), no app needed. Nothing is charged until then.`,
  };
}
