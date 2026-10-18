/**
 * A small in-process snapshot cache for PUBLIC reads that are identical for every caller.
 *
 * The public catalog and the room-occupancy snapshot are the same answer for everyone and already ride the CDN
 * (`s-maxage=60`), but a CDN miss, a dev server, or a cold lambda recomputes them in full: dozens of paged
 * database reads per browse load. This keeps one answer per instance for `ttlMs`, shares one in-flight
 * computation between concurrent callers, and never caches a failure.
 *
 * Staleness is bounded by `ttlMs` — keep it at or under the response's `s-maxage`. Never use it for anything
 * scoped to a viewer, a workspace, or a `fresh=1` read.
 */
export type TtlCache<T> = {
  get(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
};

export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now): TtlCache<T> {
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
      if (hit && hit.expiresAt > now()) return hit.value;
      const running = inflight.get(key);
      if (running) return running;
      const startedGeneration = generation;
      const started = load().then(
        (value) => {
          if (generation !== startedGeneration) return value;
          entries.set(key, { value, expiresAt: now() + ttlMs });
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
