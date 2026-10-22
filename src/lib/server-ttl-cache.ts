/**
 * A small in-process snapshot cache for PUBLIC reads that are identical for every caller.
 *
 * The public catalog and the room-occupancy snapshot are the same answer for everyone and already ride the CDN
 * (`s-maxage=60`), but a CDN miss, a dev server, or a cold lambda recomputes them in full: dozens of paged
 * database reads per browse load. This keeps one answer per instance for `ttlMs`, shares one in-flight
 * computation between concurrent callers, and never caches a failure.
 *
 * `maxEntries` bounds it as an LRU (a hit moves its key to the end, a write past the cap drops the
 * least-recently-used): pass it whenever the KEY is not a fixed name - a per-address answer, say - so a wide
 * key space cannot grow the map without end. Omitted means one entry per key, which is right for the handful
 * of fixed-key snapshots below.
 *
 * This cache and the CDN compose rather than bound each other: the CDN can serve for `s-maxage` a body that
 * was already built from a snapshot up to `ttlMs` old, so WORST-CASE public staleness is `ttlMs + s-maxage`
 * (60s + 60s ≈ 2 minutes for the public catalog). Keep `ttlMs` at or under the response's `s-maxage` so that
 * worst case stays within twice the cache header the route already advertises. Never use it for anything
 * scoped to a viewer, a workspace, or a `fresh=1` read.
 */
export type TtlCache<T> = {
  get(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
};

export function createTtlCache<T>(
  ttlMs: number,
  now: () => number = Date.now,
  opts: { maxEntries?: number } = {},
): TtlCache<T> {
  const maxEntries = opts.maxEntries && opts.maxEntries > 0 ? Math.floor(opts.maxEntries) : null;
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const inflight = new Map<string, Promise<T>>();
  // `clear()` has to be authoritative even against a load already in flight: that load still
  // settles and would otherwise write its pre-clear value back for a full TTL. A load carries the
  // generation it started under and only caches its answer while that is still current — the same
  // guard `shared-get-cache.ts` uses.
  let generation = 0;
  return {
    async get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) {
        // Re-insert so the Map's insertion order is least-recently-used first.
        entries.delete(key);
        entries.set(key, hit);
        return hit.value;
      }
      if (hit) entries.delete(key);
      const running = inflight.get(key);
      if (running) return running;
      const startedGeneration = generation;
      const started = load().then(
        (value) => {
          if (generation !== startedGeneration) return value;
          entries.delete(key);
          entries.set(key, { value, expiresAt: now() + ttlMs });
          if (maxEntries) {
            while (entries.size > maxEntries) {
              const oldest = entries.keys().next();
              if (oldest.done) break;
              entries.delete(oldest.value);
            }
          }
          inflight.delete(key);
          return value;
        },
        (error) => {
          if (generation === startedGeneration) inflight.delete(key);
          throw error;
        },
      );
      inflight.set(key, started);
      return started;
    },
    clear() {
      generation += 1;
      entries.clear();
      inflight.clear();
    },
  };
}

/** Test runs read live mocks on every call; a cache there would hide the very reads under test. */
export function serverSnapshotCacheEnabled(): boolean {
  return process.env.NODE_ENV !== "test" && !process.env.VITEST;
}
