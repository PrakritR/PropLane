/**
 * PropLane Number: $5/month for a vendor or resident, with $3.00 of message credit each UTC
 * month while the subscription is active. Client-safe constants only; docs/agents/comms-billing.md
 * § PropLane Number is the contract.
 */
export const NUMBER_SUBSCRIPTION_PRICE_CENTS = 500;
export const NUMBER_SUBSCRIPTION_LOOKUP_KEY = "proplane_number_monthly";
export const NUMBER_SUBSCRIPTION_PRODUCT_NAME = "PropLane Number";
/** Included message credit, granted once per UTC calendar month while `active`; never rolls over. */
export const NUMBER_INCLUDED_CREDIT_CENTS = 300;

export const NUMBER_SUBSCRIPTION_PURPOSE = "number_subscription";
export const NUMBER_CREDIT_PURPOSE = "number_communication_credit";

export type NumberOwnerRole = "vendor" | "resident";
export type NumberSubscriptionStatus = "active" | "past_due" | "canceled" | "incomplete";

/**
 * Off until the Stripe account, webhook events and migration are in place. A checkout is the only
 * thing this gates; webhook fulfilment and credit reads stay live so money already taken is never
 * stranded by flipping the flag.
 */
export function isNumberSubscriptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NUMBER_SUBSCRIPTION_ENABLED?.trim() === "1";
}

/** Same-origin relative path only; anything else falls back to the portal root. */
export function safeNumberReturnPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const path = value.trim();
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 200 ||
    /[\\\s]/.test(path) ||
    path.includes("://") ||
    /[\u0000-\u001f]/.test(path)
  ) {
    return fallback;
  }
  return path;
}
