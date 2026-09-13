/**
 * Processing coverage codes — the ONLY thing that makes PropLane pay Stripe's fee.
 *
 * Three unrelated kinds of code used to be able to turn this on, because the
 * account-level check was `Boolean(manager_purchases.promo_code)` — any non-empty
 * string counted as a coverage grant. On the live production database that meant
 * 19 of 61 accounts had PropLane-funded processing, and two of them had only ever
 * redeemed a SUBSCRIPTION discount (`FIRST20`, `ONBOARD_FREE_PRO`). Nobody chose
 * that; one column quietly meant two things.
 *
 * So coverage now has a namespace of its own, checked here and nowhere else:
 *
 *   - a **subscription promo** (`FREEFIRST` and friends, `stripe-promos.ts`)
 *     discounts the manager's own plan and grants no coverage;
 *   - a **manager's application-fee waiver code** is theirs, invented by them,
 *     and waives an APPLICANT's fee — it can never satisfy this;
 *   - a **processing coverage code** is ours, issued deliberately, and is the
 *     only key that fits this lock.
 *
 * Deliberately not printed in product copy: the field asks for a code, it never
 * shows one.
 */

/** Codes PropLane issues out-of-band that make us absorb the processing fee. */
const PROCESSING_COVERAGE_CODES: ReadonlySet<string> = new Set([
  "FREE100",
  "WAIVEPROCESS1",
]);

/** Upper-case, strip anything that is not a letter or digit. */
export function normalizeProcessingCoverageCode(code: string | null | undefined): string {
  return String(code ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Is this a real processing coverage code?
 *
 * Empty is false, and so is a code from any other family. A caller must never
 * fall back to "it is non-empty, so it probably counts" — that is the exact
 * mistake this module exists to stop.
 */
export function isProcessingCoverageCode(code: string | null | undefined): boolean {
  const normalized = normalizeProcessingCoverageCode(code);
  return normalized.length > 0 && PROCESSING_COVERAGE_CODES.has(normalized);
}
