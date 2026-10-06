/**
 * A vendor's Communication, texts included - client-safe, pure.
 *
 * The vendor equivalent of `resident-conversation.ts`: a vendor holds ONE
 * conversation per manager workspace (`ws:<workspace>`); their in-app turns are
 * stored rows, their TEXTS live in the SMS projection keyed by the manager's work
 * line. This module decides which projection conversations are THEIRS:
 *
 *   - a text conversation is the vendor's only through the ACCOUNT the SMS
 *     pipeline resolved (`counterparty_user_id`), or through a phone the vendor
 *     VERIFIED with a code (`profiles.phone_verified_at`). A typed phone
 *     (`vendor_business_profiles.work_phone`, `profiles.phone` unverified) never links.
 *   - if any OTHER account also verified the same number, nothing links by phone.
 *   - only `vendor` conversations are a vendor's. Resident, prospect, manager and
 *     unresolved conversations on the same number never appear.
 */
import { normalizeE164 } from "@/lib/phone-e164";

export function isVendorSmsRole(role: unknown): role is "vendor" {
  return String(role ?? "") === "vendor";
}

/** Is this projection conversation the vendor's? `null` = no. The ONE decision; the loader never re-derives it. */
export function decideVendorSmsLink(input: {
  vendorId: string;
  /** The vendor's verified phone (E.164), or null when none is verified. */
  verifiedPhone: string | null;
  /** Every distinct account id that verified `verifiedPhone` (including the vendor). */
  phoneVerifierIds: readonly string[];
  row: { role: unknown; counterpartyUserId: string | null; counterpartyPhone: string | null };
}): "account" | "verified_phone" | null {
  if (!isVendorSmsRole(input.row.role)) return null;
  const userId = String(input.row.counterpartyUserId ?? "").trim();
  if (userId) return userId === input.vendorId ? "account" : null;
  if (!input.verifiedPhone) return null;
  const phone = normalizeE164(input.row.counterpartyPhone);
  if (!phone || phone !== input.verifiedPhone) return null;
  const verifiers = [...new Set(input.phoneVerifierIds)];
  if (verifiers.length !== 1 || verifiers[0] !== input.vendorId) return null;
  return "verified_phone";
}
