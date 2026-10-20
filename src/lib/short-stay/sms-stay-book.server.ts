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
import { bookGuestStays } from "@/lib/short-stay/guest-stays.server";
import { SHORT_STAY_HOLD_HOURS } from "@/lib/short-stay/guest-stays";
import { ensureGuestLogin } from "@/lib/short-stay/guest-login.server";
import type { StayOfferOption } from "@/lib/short-stay/sms-stay-offers.server";
import { mintStayPayLink } from "@/lib/short-stay/stay-pay-link.server";
import { loadShortStayListing } from "@/lib/short-stay-request.server";
import { formatShortStayMoney, shortStayRangeLabel } from "@/lib/short-stay-request";
import { normalizeE164 } from "@/lib/phone-e164";

export type SmsStayBooking =
  | { ok: true; status: "hold" | "confirmed"; blockId: string; total: number; reply: string }
  | { ok: false; error: "bad_phone" | "rate_limited" | "no_login" | "price_changed" | "unavailable" | "failed"; message: string; total?: number };

export async function bookStayForTexter(
  db: SupabaseClient,
  input: { option: StayOfferOption; phone: string; name?: string; now?: Date },
): Promise<SmsStayBooking> {
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

  const login = await ensureGuestLogin(db, { name: (input.name ?? "").trim(), phone }).catch(() => null);
  if (!login?.userId) return { ok: false, error: "no_login", message: "I could not set up a booking for this number." };

  const booked = await bookGuestStays(db, {
    userId: login.userId,
    body: {
      propertyId: option.propertyId,
      roomId: option.roomId,
      guests: option.guests,
      ranges: [{ checkIn: option.checkIn, checkOut: option.checkOut }],
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
        ? `Booked: ${where}, ${range}, ${money} total. Pay here, we text you a code when you open it: ${payUrl}`
        : `Booked: ${where}, ${range}, ${money} total. We will text you the payment link shortly.`,
    };
  }
  return {
    ok: true,
    status: "hold",
    blockId: result.stayId,
    total,
    reply: `Request sent: ${where}, ${range}, ${money} total. The host has ${SHORT_STAY_HOLD_HOURS} hours to confirm. The moment they do, I text you a link to pay ${money} right here, no app needed. Nothing is charged until then.`,
  };
}
