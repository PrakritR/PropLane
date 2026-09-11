/**
 * Coalesces concurrent "force a fresh read" calls into the fewest network
 * requests that still satisfy every caller.
 *
 * ## Why this exists
 *
 * The portal sync helpers (`syncPropertyPipelineFromServer`,
 * `syncProRelationshipsFromServer`, …) already carry a TTL + in-flight guard, so
 * unforced callers collapse into one fetch. But a mount-time effect that wants
 * guaranteed-fresh data passes `{ force: true }`, which bypasses BOTH guards —
 * and several panels mount at once on a portal page. Measured on
 * `/portal/properties`: `/api/property-records` fetched 5x and
 * `/api/portal-pro-relationships` 6x on a single load, because six components
 * each forced the same sync during first paint.
 *
 * ## The correctness rule this preserves
 *
 * A forced caller is promising its own caller "data at least as new as the
 * moment I asked". So it is NOT safe to simply hand it the in-flight request:
 * that fetch may have STARTED BEFORE a write the caller just made
 * (save-then-refresh is a real pattern here — see
 * `pro-add-listing-form.tsx`), and joining it would return pre-write data.
 *
 * So this helper never joins a request that started too early. Instead it keeps
 * at most ONE queued follow-up: every forced caller that arrives while a request
 * is in flight joins that single queued run, which only begins once the current
 * one settles — i.e. strictly after each joined caller asked. N concurrent
 * forced callers therefore cost at most 2 network requests (the in-flight one
 * plus one shared follow-up) instead of N, and each still gets a fetch that
 * began after its own call.
 *
 * Coverage: `tests/unit/coalesced-refresh.test.ts`.
 */

export type CoalescedRefresher<T> = {
  /**
   * `force: false` (the default) is the cheap path — it joins any in-flight run,
   * because an unforced caller has no freshness promise to keep.
   *
   * `force: true` guarantees a run that STARTS after this call.
   */
  run(force?: boolean): Promise<T>;
  /** Test/debug hook: drops all cached state. */
  reset(): void;
};

export function createCoalescedRefresher<T>(fetcher: () => Promise<T>): CoalescedRefresher<T> {
  let inFlight: Promise<T> | null = null;
  // The single shared follow-up that forced callers arriving mid-flight join.
  let queued: Promise<T> | null = null;

  // Identifies the current run, so a finishing run only clears the slot when it
  // is still the current one — a queued run promotes itself and must not be
  // cleared by the run it was waiting on.
  let runToken = 0;

  function start(): Promise<T> {
    const token = ++runToken;
    const promise = (async () => {
      try {
        return await fetcher();
      } finally {
        if (runToken === token) inFlight = null;
      }
    })();
    inFlight = promise;
    return promise;
  }

  return {
    run(force = false): Promise<T> {
      if (!force) {
        // No freshness promise to keep — any in-flight (or queued) run will do.
        return inFlight ?? queued ?? start();
      }

      if (!inFlight) return start();

      // A run is in flight and may have started before this caller's write.
      // Join the single queued follow-up, creating it if this is the first
      // forced caller to arrive during this flight.
      if (queued) return queued;

      const current = inFlight;
      const follow = (async () => {
        // Wait out the current run regardless of how it settles, then fetch.
        await current.catch(() => undefined);
        // Promote: this run becomes the in-flight one, and the queue reopens so
        // callers arriving from here on get their own follow-up rather than
        // joining a run that is already starting.
        queued = null;
        return await start();
      })();
      queued = follow;
      return follow;
    },
    reset() {
      inFlight = null;
      queued = null;
    },
  };
}
