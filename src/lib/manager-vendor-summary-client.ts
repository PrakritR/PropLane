import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";
import type { ManagerVendorSummary } from "@/lib/manager-vendor-summary.server";

const TTL_MS = 15_000;

type Entry = { value: ManagerVendorSummary | null; loadedAt: number; refresher: CoalescedRefresher<ManagerVendorSummary> };
const entries = new Map<string, Entry>();

function entryFor(viewerId: string, vendorDirectoryId: string): Entry {
  const key = `${viewerId}\u0000${vendorDirectoryId}`;
  const existing = entries.get(key);
  if (existing) return existing;
  const entry: Entry = {
    value: null,
    loadedAt: 0,
    refresher: createCoalescedRefresher(async () => {
      const response = await fetch(`/api/portal-vendors/${encodeURIComponent(vendorDirectoryId)}/summary`, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Could not load vendor history.");
      const value = (await response.json()) as ManagerVendorSummary;
      entry.value = value;
      entry.loadedAt = Date.now();
      return value;
    }),
  };
  entries.set(key, entry);
  return entry;
}

/** Manager-only summary cache. The viewer id is part of every key to prevent cross-account reuse. */
export async function loadManagerVendorSummary(viewerId: string | null, vendorDirectoryId: string, force = false): Promise<ManagerVendorSummary> {
  if (!viewerId?.trim() || !vendorDirectoryId.trim()) throw new Error("Missing manager summary scope.");
  const entry = entryFor(viewerId, vendorDirectoryId);
  if (!force && entry.value && Date.now() - entry.loadedAt < TTL_MS) return entry.value;
  return entry.refresher.run(force);
}

export function invalidateManagerVendorSummary(viewerId: string | null, vendorDirectoryId: string): void {
  if (!viewerId?.trim() || !vendorDirectoryId.trim()) return;
  const entry = entries.get(`${viewerId}\u0000${vendorDirectoryId}`);
  if (entry) entry.loadedAt = 0;
}

export function resetManagerVendorSummaryCache(): void {
  entries.clear();
}
