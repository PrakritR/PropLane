/**
 * What a person reads for a maintenance pass-through charge's title.
 *
 * The product has no "work orders" — a manager, a resident and a vendor read "service"
 * everywhere (`AGENTS.md`). The SCHEMA keeps the `work_order_charge` kind and every row written
 * before the rename keeps the retired word in its stored title, because a stored title is money
 * evidence: it is never rewritten, in the ledger or anywhere else. The normalization happens on
 * the way to a person, and only there.
 *
 * This module holds no browser or server dependency on purpose. The same decision has to be
 * reachable from a React component, from the manager ledger projection and from the reminder and
 * autopay routes that put a charge's title into an email, a text and a banner —
 * `tests/unit/services-vocabulary.test.ts` scans only `src/components` and `src/app` for the
 * literal, so a projection that hands the raw title out is exactly the gap it cannot see.
 */

/** The prefix a newly generated maintenance pass-through charge is titled with. */
export const SERVICE_CHARGE_TITLE_PREFIX = "Service · ";
const LEGACY_SERVICE_CHARGE_TITLE_PREFIX = "Work order · ";
const LEGACY_SERVICE_CHARGE_TITLE = "Work order";

/**
 * Gated on the kind: ONLY a `work_order_charge`'s own retired prefix is normalized, so a title
 * someone typed that happens to contain those words is left exactly as typed, and no other
 * charge's title is touched.
 */
export function serviceChargeDisplayTitle(
  charge: { kind?: string | null; title?: string | null },
  fallback = "Charge",
): string {
  const title = charge.title?.trim() ?? "";
  if (!title) return fallback;
  if (charge.kind !== "work_order_charge") return title;
  if (title.startsWith(LEGACY_SERVICE_CHARGE_TITLE_PREFIX)) {
    return `${SERVICE_CHARGE_TITLE_PREFIX}${title.slice(LEGACY_SERVICE_CHARGE_TITLE_PREFIX.length)}`;
  }
  return title === LEGACY_SERVICE_CHARGE_TITLE ? "Service" : title;
}
