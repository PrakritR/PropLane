import "server-only";
import { normalizeProcessingCoverageCode } from "@/lib/processing-coverage-codes";

/**
 * The processing coverage codes themselves. SERVER ONLY — never bundled.
 *
 * These used to live beside the matcher in a module the client imported, so
 * `WAIVEPROCESS1` was verifiably sitting in a browser chunk. Any manager who
 * opened devtools could read it, type it into a listing's coverage field and
 * have PropLane absorb Stripe's processing fee on every resident payment for
 * that listing, forever, with no grant recorded anywhere. The property write
 * path does not re-derive the field, so the client's own claim was the only
 * check there ever was.
 *
 * A code is a credential. It is validated where the browser cannot read it,
 * and the client asks (`POST /api/portal/verify-coverage-code`) rather than
 * deciding for itself.
 */
/**
 * The code PropLane shares out-of-band. Server only — it used to be exported
 * from `payment-policy.ts`, which the browser bundles.
 */
export const LISTING_PAYMENT_WAIVER_CODE = "FREE100";

/** The second coverage code. Same rule: never bundled. */
export const LISTING_PROCESSING_FEE_PROMO_CODE = "WAIVEPROCESS1";

const PROCESSING_COVERAGE_CODES: ReadonlySet<string> = new Set([
  LISTING_PAYMENT_WAIVER_CODE,
  LISTING_PROCESSING_FEE_PROMO_CODE,
]);

/**
 * Is this a real processing coverage code?
 *
 * Empty is false, and so is a code from any other family — a subscription promo
 * or a manager's own application-fee waiver code must never satisfy this.
 */
export function isProcessingCoverageCode(code: string | null | undefined): boolean {
  const normalized = normalizeProcessingCoverageCode(code);
  return normalized.length > 0 && PROCESSING_COVERAGE_CODES.has(normalized);
}
