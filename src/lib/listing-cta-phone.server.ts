import "server-only";
import {
  isFictionalUs555Number,
  isLegacyClawSharedSmsNumber,
} from "@/lib/claw-leasing-links";
import { normalizePhoneE164 } from "@/lib/communication-other-recipients";

/**
 * A public listing's "Text" CTA always targets that property's own manager's
 * Twilio work number (`profiles.sms_from_number`). The retired shared Claw line
 * is never a fallback, and the manager's personal cell is never used — prospects
 * must text the leasing work number so inbound hits the leasing agent / inbox.
 */
export function listingCtaSendsToManagerOwnPhone(): boolean {
  return true;
}

/** The `profiles` columns `resolveListingCtaSmsPhone` needs. */
export type ListingCtaManagerProfile = {
  phone?: string | null;
  phone_verified_at?: string | null;
  sms_from_number?: string | null;
};

/**
 * Resolve the `sms:` target for ONE property, from ITS OWN manager's work number.
 *
 * Callers must pass the profile of the manager who owns that specific listing —
 * never a catalog-wide default — so a multi-manager fleet can never cross-route
 * a prospect to the wrong manager's phone.
 *
 * Returns `null` when there is no usable work number. That is not an error: the
 * CTA components omit the Text button and leave Schedule tour / Apply, so no
 * dead `sms:` link is ever rendered and no personal cell is substituted.
 */
export function resolveListingCtaSmsPhone(
  manager: ListingCtaManagerProfile | null | undefined,
): string | null {
  // Twilio-provisioned work number only. Personal `profiles.phone` is deliberately
  // ignored: texting a cell opens Messages to a private number and skips the
  // work-number inbound path (leasing agent + Communication).
  const e164 = normalizePhoneE164(String(manager?.sms_from_number ?? ""));
  if (!e164) return null;
  // Seed placeholders, and the shared agent line (which is stamped onto every
  // manager's `sms_from_number` in older environments and is nobody's *own*
  // work number).
  if (isFictionalUs555Number(e164)) return null;
  if (isLegacyClawSharedSmsNumber(e164)) return null;
  return e164;
}
