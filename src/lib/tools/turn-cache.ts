/**
 * Per-turn read cache. An agent turn runs many tools against ONE context object, and several of them read the same
 * heavy rows (applications, leases, charges, the property records with their whole listing submissions). Within a turn
 * the first read is shared; a new turn builds a new context and reads fresh. Any executed write drops the context's
 * cache, so a read after a write in the same context always sees the write. A failed read is never kept.
 */
const caches = new WeakMap<object, Map<string, Promise<unknown>>>();

export function turnCached<T>(ctx: object, key: string, read: () => Promise<T>): Promise<T> {
  let byKey = caches.get(ctx);
  if (!byKey) caches.set(ctx, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit as Promise<T>;
  const pending = read();
  byKey.set(key, pending);
  pending.catch(() => {
    if (byKey!.get(key) === pending) byKey!.delete(key);
  });
  return pending;
}

/** Drop everything cached for this context (called after any write executes). */
export function invalidateTurnCache(ctx: object): void {
  caches.delete(ctx);
}
