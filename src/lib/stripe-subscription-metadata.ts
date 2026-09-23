/** Stripe Subscription.metadata keys for deferred plan changes (downgrade at renewal). */
export const META_SCHEDULED_TIER = "axis_scheduled_tier";
export const META_SCHEDULED_BILLING = "axis_scheduled_billing";

/**
 * Stripe Subscription.metadata key pinning the `RATE_CARD_VERSION`
 * (`src/lib/billing/rate-card.ts`) an account migrated onto per-door pricing
 * under. Set once, at checkout creation or the first tier change that lands
 * a subscription on the door-overage item shape, and NEVER overwritten after
 * that — see `resolveRateCardVersionMetadataPatch` in
 * `src/lib/billing/quantity-sync.server.ts`, which is the only place that
 * decides whether to write it.
 */
export const META_RATE_CARD_VERSION = "axis_rate_card_version";
