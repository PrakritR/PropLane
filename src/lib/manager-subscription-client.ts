/**
 * Client-side cache for GET /api/manager/subscription so Properties and other
 * tier-gated surfaces don't each pay for a cold fetch on first interaction.
 *
 * TWO values, because the response carries two and they are not interchangeable:
 *
 * - `tier` — the raw committed SKU in `manager_purchases`, `null` for an account
 *   with no purchase row. Every gate that mirrors a SERVER check which still
 *   reads `null` as legacy full access (`getManagerSubscriptionTier`) wants
 *   this one, or the interface hides a surface the API happily serves. That is
 *   the Screenings panel: `orderScreeningForApplication` permits a rowless
 *   account, so paywalling it client-side would blank a working screen.
 *   → `loadManagerSubscriptionTierClient`
 * - `effectiveTier` — the plan the product HOLDS the account to
 *   (`resolveEffectiveManagerSkuTier`: no committed SKU and no live
 *   Stripe/Apple grant → Free). Only the property-limit pre-checks want this,
 *   because `POST /api/property-records` re-resolves the identical value and
 *   would otherwise refuse a write the interface said was fine.
 *   → `loadManagerEffectivePlanTierClient`
 *
 * Both are filled by ONE request; a new caller picks the value matching the
 * server gate it is previewing, never "whichever is stricter".
 */

let cachedTier: string | null | undefined;
let cachedEffectiveTier: string | null | undefined;
let cachedPaymentWaiverGranted: boolean | undefined;
let inflight: Promise<void> | null = null;

function loadSubscription(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetch("/api/manager/subscription", { credentials: "include" })
    .then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as {
        tier?: string | null;
        effectiveTier?: string | null;
        planUnknown?: boolean;
        paymentWaiverGranted?: boolean;
      };
      if (!res.ok) {
        cachedTier = null;
        cachedEffectiveTier = null;
        cachedPaymentWaiverGranted = false;
        return;
      }
      // The route could not read this account's plan. Caching that would freeze
      // a transient database error into the whole session — the pre-checks
      // would keep judging against a plan nobody ever resolved. Leave both
      // slots empty so the next caller retries; until then every reader sees
      // `null`, which pre-judges nothing and defers to the server gate.
      if (body.planUnknown === true) return;
      cachedTier = body.tier ?? null;
      // An older deployment of the route sends no `effectiveTier`; falling back
      // to the raw tier keeps the pre-check at its pre-cap behaviour rather
      // than inventing a Free plan the server is not enforcing.
      cachedEffectiveTier = body.effectiveTier ?? body.tier ?? null;
      cachedPaymentWaiverGranted = body.paymentWaiverGranted === true;
    })
    .catch(() => {
      cachedTier = null;
      cachedEffectiveTier = null;
      cachedPaymentWaiverGranted = false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function readManagerSubscriptionTierClient(): string | null | undefined {
  return cachedTier;
}

export function loadManagerSubscriptionTierClient(): Promise<string | null> {
  if (cachedTier !== undefined) return Promise.resolve(cachedTier);
  return loadSubscription().then(() => cachedTier ?? null);
}

export function readManagerEffectivePlanTierClient(): string | null | undefined {
  return cachedEffectiveTier;
}

export function loadManagerEffectivePlanTierClient(): Promise<string | null> {
  if (cachedEffectiveTier !== undefined) return Promise.resolve(cachedEffectiveTier);
  return loadSubscription().then(() => cachedEffectiveTier ?? null);
}

export function loadManagerPaymentWaiverGrantedClient(): Promise<boolean> {
  if (cachedPaymentWaiverGranted !== undefined) return Promise.resolve(cachedPaymentWaiverGranted);
  return loadSubscription().then(() => cachedPaymentWaiverGranted === true);
}

/** Test / sign-out hooks may clear the cache. */
export function resetManagerSubscriptionTierClientCache() {
  cachedTier = undefined;
  cachedEffectiveTier = undefined;
  cachedPaymentWaiverGranted = undefined;
  inflight = null;
}
