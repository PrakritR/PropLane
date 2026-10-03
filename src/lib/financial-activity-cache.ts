import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";
import { isServerSyncOriginatedEvent } from "@/lib/property-pipeline-events";
import { selectedWorkspaceId } from "@/lib/workspaces/selection";
import type { ReportResult } from "@/lib/reports/types";

type Entry = { result?: ReportResult; loadedAt: number; revision: number; dirty: boolean; refresh: CoalescedRefresher<ReportResult> };
const entries = new Map<string, Entry>();
const seenEvents = new WeakSet<Event>();
/** A mirror notification contains no new write. One mutation invalidates shared reads once. */
export function invalidateFinancialActivity(event: Event): boolean {
  if (isServerSyncOriginatedEvent(event)) return false;
  if (!seenEvents.has(event)) {
    seenEvents.add(event);
    for (const entry of entries.values()) { entry.revision += 1; entry.dirty = true; }
  }
  return true;
}
export function loadFinancialActivity(userId: string | null | undefined, propertyId = ""): Promise<ReportResult> {
  const key = JSON.stringify([userId, selectedWorkspaceId(), propertyId]);
  let entry = entries.get(key);
  if (!entry) {
    const next: Entry = { loadedAt: 0, revision: 0, dirty: false, refresh: createCoalescedRefresher(async () => {
      const revision = next.revision;
      const query = propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : "";
      const response = await fetch(`/api/reports/financial-activity${query}`);
      const report = await response.json();
      if (!response.ok) throw new Error(report.error || "Could not load financial activity.");
      if (revision === next.revision) { next.result = report; next.loadedAt = Date.now(); next.dirty = false; }
      return report as ReportResult;
    }) };
    entries.set(key, next); entry = next;
  }
  if (!entry.dirty && entry.result && Date.now() - entry.loadedAt < 30_000) return Promise.resolve(entry.result);
  return entry.refresh.run(entry.dirty);
}
