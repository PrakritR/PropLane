import "server-only";
import { isProcessingCoverageCode } from "@/lib/processing-coverage-codes.server";

/**
 * The half of payment policy that needs the coverage codes themselves.
 *
 * `payment-policy.ts` is imported by `"use client"` components, so anything it
 * holds is bundled — which is how `WAIVEPROCESS1` came to be readable in a
 * browser chunk, and with it a manager could self-grant PropLane-funded card
 * processing on any listing, permanently, with no grant row anywhere. The
 * decisions that depend on a code live here instead, where the browser cannot
 * reach them, and the shared module's versions return `false` so a client can
 * never conclude coverage is granted on its own.
 */

/** The account's own coverage grant (`manager_purchases.promo_code`). */
export function waiverGrantedFromPromoCodeServer(promoCode: string | null | undefined): boolean {
  return isProcessingCoverageCode(promoCode);
}

/** Does this listing's stored code turn on PropLane coverage? */
export function listingPaymentWaiverCodeMatchesServer(code: string | null | undefined): boolean {
  return isProcessingCoverageCode(code);
}

/**
 * The two independent sources that let PropLane cover the fee: the account's
 * grant, or the listing's own valid code.
 *
 * NOTE for whoever revisits this — a listing-level code being sufficient on its
 * own is why a leaked code was worth so much. Requiring the ACCOUNT grant would
 * close that by construction, but it is a product decision (it would revoke the
 * one production listing currently covered by a listing code whose account has
 * no grant at all), so it is deliberately left as it was rather than changed
 * under cover of a security fix.
 */
export function resolveAccountOrListingWaiverGrantedServer(
  accountPromoCode: string | null | undefined,
  listingWaiverCode?: string | null,
): boolean {
  return (
    waiverGrantedFromPromoCodeServer(accountPromoCode) ||
    listingPaymentWaiverCodeMatchesServer(listingWaiverCode)
  );
}
