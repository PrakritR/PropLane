import { createTtlCache, serverSnapshotCacheEnabled, type TtlCache } from "@/lib/server-ttl-cache";

/**
 * A short per-user, in-process answer to "does this account own a locked PropLane Service workspace?"
 * (`managed_read_only_owner_locked()`), asked by the middleware before every non-allowlisted /api write.
 *
 * A burst of writes (autosave, a bulk action) asked the database the same question on each request. The answer is
 * kept per instance for `MANAGED_LOCK_TTL_MS` (30 s at most), keyed on the authenticated user id only. The
 * session check (`getUser()`) is NOT cached: it still runs on every request and supplies the key.
 *
 * Only a definite answer (true or false) is ever kept. A failed lookup throws out of `load`, `createTtlCache`
 * stores nothing for it, and the caller refuses the write (fail closed), so an error is never remembered as
 * "not locked".
 */
export const MANAGED_LOCK_TTL_MS = 20_000;

export type ManagedLockCache = {
  get(userId: string, load: () => Promise<boolean>): Promise<boolean>;
  clear(): void;
};

export function createManagedLockCache(ttlMs: number = MANAGED_LOCK_TTL_MS, now: () => number = Date.now): ManagedLockCache {
  const cache: TtlCache<boolean> = createTtlCache<boolean>(Math.min(ttlMs, 30_000), now, { maxEntries: 2000 });
  return {
    get: (userId, load) => cache.get(userId, load),
    clear: () => cache.clear(),
  };
}

const sharedCache = createManagedLockCache();

/** The middleware's reader: cached in a running server, a live read in tests (mocks must be read on every call). */
export function readManagedLockCached(userId: string, load: () => Promise<boolean>): Promise<boolean> {
  if (!userId || !serverSnapshotCacheEnabled()) return load();
  return sharedCache.get(userId, load);
}
