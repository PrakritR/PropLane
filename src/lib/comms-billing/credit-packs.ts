/** Retail credit and purchase price are equal; no automatic replenishment. */

/**
 * @deprecated Kept only for the public pricing page's illustrative "$5, $10,
 * $25, $50" copy (`src/app/(public)/pricing/page.tsx`). The actual checkout
 * flow (Settings → Billing & plan → Extra usage) takes a typed whole-dollar
 * amount validated by `isValidCommsCreditAmountCents`, not a fixed pack —
 * see `docs/agents/comms-billing.md` § Purchases and stops.
 */
export const COMMS_CREDIT_PACKS_CENTS = [500, 1000, 2500, 5000] as const;
export const COMMS_CREDIT_PURPOSE = "manager_communication_credit";

/** Whole-dollar bounds for a manual communication-credit purchase (PLAN-0920-1400). */
export const COMMS_CREDIT_MIN_CENTS = 500;
export const COMMS_CREDIT_MAX_CENTS = 50_000;
/** Default amount shown in the Extra usage amount field. */
export const COMMS_CREDIT_DEFAULT_CENTS = 2000;

/**
 * @deprecated Superseded by `isValidCommsCreditAmountCents`, which accepts any
 * whole-dollar amount in range rather than one of four fixed packs. Kept only
 * so nothing importing it breaks; do not add new callers.
 */
export function isCommsCreditPack(
  value: unknown,
): value is (typeof COMMS_CREDIT_PACKS_CENTS)[number] {
  return (
    typeof value === "number" &&
    COMMS_CREDIT_PACKS_CENTS.some((amount) => amount === value)
  );
}

/**
 * The one bound a manual communication-credit purchase must satisfy, checked
 * identically at checkout creation (`credit-purchase.server.ts`), the
 * checkout route, and webhook fulfillment: a whole dollar amount (no cents),
 * from $5 to $500 inclusive.
 */
export function isValidCommsCreditAmountCents(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= COMMS_CREDIT_MIN_CENTS &&
    value <= COMMS_CREDIT_MAX_CENTS &&
    value % 100 === 0
  );
}
