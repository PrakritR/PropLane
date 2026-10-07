/**
 * Cross-request memo of a COMPLETED tier sync, per user.
 *
 * The sync (Stripe + RevenueCat lookups, then DB writes) is deduped per request
 * by React.cache in manager-access-server.ts, so a page that fans out into 30 API
 * calls ran it up to 30 times. This keeps the last successful run for 60s and
 * collapses concurrent runs into one promise. It memoizes only the reconcile
 * side effects: the tier itself is always re-read from `manager_purchases`, so
 * `resolveEffectiveManagerSkuTier` stays the one plan a quota reads.
 *
 * Fail closed: a run in which any provider lookup threw (or anything else threw)
 * is never cached, so a transient Stripe/RevenueCat error is retried on the next
 * call rather than frozen for a minute. Every writer that changes subscription
 * or purchase state calls `invalidateManagerTierCache`.
 */
export const MANAGER_TIER_CACHE_TTL_MS = 60_000;
const MANAGER_TIER_CACHE_MAX_ENTRIES = 500;

export const managerTierSyncedAt = new Map<string, number>();
export const managerTierSyncInFlight = new Map<string, Promise<boolean>>();

export function managerTierCacheEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return process.env.MANAGER_TIER_CACHE_IN_TEST === "1";
  return true;
}

/** Drops the cached sync (and detaches any in-flight run) for one user, or for everyone. */
export function invalidateManagerTierCache(userId?: string): void {
  if (userId === undefined) {
    managerTierSyncedAt.clear();
    managerTierSyncInFlight.clear();
    return;
  }
  const uid = userId.trim();
  if (!uid) return;
  managerTierSyncedAt.delete(uid);
  // A run that started before this write must not repopulate the cache.
  managerTierSyncInFlight.delete(uid);
}

export function rememberManagerTierSync(uid: string): void {
  managerTierSyncedAt.delete(uid);
  managerTierSyncedAt.set(uid, Date.now());
  while (managerTierSyncedAt.size > MANAGER_TIER_CACHE_MAX_ENTRIES) {
    const oldest = managerTierSyncedAt.keys().next().value;
    if (oldest === undefined) break;
    managerTierSyncedAt.delete(oldest);
  }
}
