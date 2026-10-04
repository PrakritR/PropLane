/**
 * One GET per URL per page load, shared by every reader.
 *
 * ## Why this exists
 *
 * A property record mounts several components that each read the same
 * workspace- or property-scoped route from their own effect (the listing
 * contact hooks, the signing-context hook, the form-setup hook that both the
 * Applications and Lease panels call). Measured on one visit, the work-number,
 * assistant-email and application-settings routes were each fetched two or
 * three times. Each reader only wants the answer, not its own request.
 *
 * The cache is keyed by the full URL, so a workspace id or property id is part
 * of the key and two scopes never share an answer. Concurrent readers join one
 * in-flight request (`createCoalescedRefresher`); later readers inside the TTL
 * reuse the settled answer. A failed read is never cached, so the next reader
 * retries. A write to the same route calls `invalidateSharedGets` so the next
 * read is fresh — a forced read (`force: true`) also bypasses the TTL.
 *
 * The request is bounded by a timeout so a hung route cannot pin the in-flight
 * slot forever (a hung slot would starve every later reader).
 *
 * Coverage: `tests/unit/shared-get-cache.test.ts`.
 */
import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";

export const SHARED_GET_TTL_MS = 30_000;
export const SHARED_GET_TIMEOUT_MS = 15_000;

export type SharedGetResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; data: null };

type Entry = {
  /** Bumped by an invalidate, so a read that began before a write never settles into the cache. */
  generation: number;
  refresher: CoalescedRefresher<SharedGetResult>;
  settled?: { at: number; result: SharedGetResult & { ok: true } };
};

const entries = new Map<string, Entry>();

function makeRefresher(url: string, entry: () => Entry): CoalescedRefresher<SharedGetResult> {
  return createCoalescedRefresher<SharedGetResult>(async () => {
    const startedGeneration = entry().generation;
    try {
      const res = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" }, SHARED_GET_TIMEOUT_MS);
      if (!res.ok) return { ok: false, status: res.status, data: null };
      const data = (await res.json().catch(() => null)) as unknown;
      const result: SharedGetResult & { ok: true } = { ok: true, status: res.status, data };
      if (entry().generation === startedGeneration) entry().settled = { at: Date.now(), result };
      return result;
    } catch {
      return { ok: false, status: 0, data: null };
    }
  });
}

function entryFor(url: string): Entry {
  const existing = entries.get(url);
  if (existing) return existing;
  const created = { generation: 0 } as Entry;
  created.refresher = makeRefresher(url, () => created);
  entries.set(url, created);
  return created;
}

/** GET `url` once per TTL; concurrent callers share one request. */
export function sharedGet(url: string, opts?: { force?: boolean; ttlMs?: number }): Promise<SharedGetResult> {
  const entry = entryFor(url);
  const ttl = opts?.ttlMs ?? SHARED_GET_TTL_MS;
  if (!opts?.force && entry.settled && Date.now() - entry.settled.at < ttl) {
    return Promise.resolve(entry.settled.result);
  }
  return entry.refresher.run(opts?.force === true);
}

/**
 * Drop settled answers (all, or those whose URL starts with `prefix`) after a write to the route.
 *
 * The entry's refresher is replaced too, not just its cached answer: a request that started BEFORE
 * the write would otherwise still be joined by the next unforced reader (`run(false)` joins any
 * in-flight run), handing a reader that mounted after the write the pre-write answer with nothing
 * to refetch it. A fresh refresher makes the next reader start a request of its own; the callers
 * already waiting on the old flight keep the answer they asked for.
 */
export function invalidateSharedGets(prefix?: string): void {
  for (const [url, entry] of entries) {
    if (prefix && !url.startsWith(prefix)) continue;
    entry.settled = undefined;
    entry.generation += 1;
    entry.refresher = makeRefresher(url, () => entry);
  }
}

export function resetSharedGets(): void {
  entries.clear();
}

if (typeof window !== "undefined") {
  // Another account must never read the previous one's answers.
  onPortalSessionViewerChange(() => resetSharedGets());
}

/**
 * `fetch` for a WRITE to a route whose GET is shared above: once the write
 * settles (success or not) every cached read under `url` is dropped, so the
 * next reader asks the server instead of serving the pre-write answer.
 */
export async function writeThroughFetch(
  url: string,
  init: RequestInit,
  /**
   * What to invalidate, when the write URL is not a prefix of every read it affects — a write to
   * `…?workspaceId=x` does not prefix-match the same route read without the query. Pass the route
   * path and every scope's cached answer for it is dropped.
   */
  opts?: { invalidatePrefix?: string },
): Promise<Response> {
  try {
    return await fetch(url, init);
  } finally {
    invalidateSharedGets(opts?.invalidatePrefix ?? url);
  }
}
