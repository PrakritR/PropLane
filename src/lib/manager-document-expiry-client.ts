/**
 * Client loader for the manager dashboard's document-expiry counts.
 *
 * The dashboard fires this from an effect keyed on its generic `tick` counter,
 * which is bumped by ~10 unrelated store events (inbox, work orders, service
 * requests, charges, leases, applications…). During first paint those loaders
 * all land within a second of each other, so the banner's counts were refetched
 * once per bump — measured at 6 identical `/api/manager-documents/expiration-summary`
 * requests on a single `/portal/dashboard` load.
 *
 * This wraps the fetch in the same TTL + coalescing guard the other portal sync
 * helpers use, so a burst of bumps costs one request while a genuinely later
 * change still refetches.
 *
 * The cache is keyed on the signed-in manager's user id, exactly like
 * `propertyPipelineRefreshers` / `relationshipsRefreshers`. These are
 * per-manager document counts, so a module-global cache would serve the
 * PREVIOUS manager's numbers for the length of the TTL after an in-session
 * account switch — a cross-tenant read, which must be impossible rather than
 * merely short-lived. Coverage: `tests/unit/manager-document-expiry-client.test.ts`.
 */
import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";
import type { DocumentExpirationSummary } from "@/lib/documents/document-expiration";
import { selectedWorkspaceId } from "@/lib/workspaces/selection";

const EXPIRY_SUMMARY_TTL_MS = 15_000;

type ExpiryCacheEntry = {
  summary: DocumentExpirationSummary | null;
  lastLoadedAt: number;
  refresher: CoalescedRefresher<DocumentExpirationSummary | null>;
};

const entriesByUser = new Map<string, ExpiryCacheEntry>();

function entryFor(userKey: string): ExpiryCacheEntry {
  const existing = entriesByUser.get(userKey);
  if (existing) return existing;
  const entry: ExpiryCacheEntry = {
    summary: null,
    lastLoadedAt: 0,
    refresher: createCoalescedRefresher(async () => {
      const res = await fetch("/api/manager-documents/expiration-summary", { credentials: "include" });
      if (!res.ok) return entry.summary;
      const body = (await res.json()) as { summary?: DocumentExpirationSummary };
      if (body?.summary) {
        entry.summary = body.summary;
        entry.lastLoadedAt = Date.now();
      }
      return entry.summary;
    }),
  };
  entriesByUser.set(userKey, entry);
  return entry;
}

/**
 * Returns the summary for `userId`, reusing a cached one inside the TTL. Pass
 * `force` after a document write to guarantee a read newer than the write.
 */
export async function loadDocumentExpirationSummary(opts?: {
  userId?: string | null;
  force?: boolean;
}): Promise<DocumentExpirationSummary | null> {
  // The summary is the ACTIVE workspace's (the route narrows by the workspace cookie), so the
  // workspace is part of the cache key: switching workspaces never serves the other one's counts.
  const entry = entryFor(`${opts?.userId?.trim() ?? ""}:${selectedWorkspaceId() ?? ""}`);
  const force = opts?.force === true;
  if (!force && entry.lastLoadedAt > 0 && Date.now() - entry.lastLoadedAt < EXPIRY_SUMMARY_TTL_MS) {
    return entry.summary;
  }
  return entry.refresher.run(force);
}

/** Drops every cached summary (account switch, and test setup). */
export function resetDocumentExpirationSummaryCache(): void {
  entriesByUser.clear();
}
