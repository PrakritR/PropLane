import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import type { ResidentTourView } from "@/lib/tour-resident-link.server";

const RESIDENT_TOURS_TTL_MS = 15_000;
export const RESIDENT_TOURS_CHANGED_EVENT = "axis:resident-tours-changed";

type TourCacheEntry = {
  generation: number;
  latestStartedGeneration: number;
  refreshedAt: number;
  tours: ResidentTourView[] | null;
  refresher: ReturnType<typeof createCoalescedRefresher<ResidentTourView[] | null>>;
};

const entries = new Map<string, TourCacheEntry>();

export function residentToursViewerKey(userId: string, email: string): string {
  return JSON.stringify([userId, email.trim().toLowerCase()]);
}

function entryFor(key: string): TourCacheEntry {
  const existing = entries.get(key);
  if (existing) return existing;

  const entry: TourCacheEntry = {
    generation: 0,
    latestStartedGeneration: -1,
    refreshedAt: 0,
    tours: null,
    refresher: null as unknown as TourCacheEntry["refresher"],
  };
  entry.refresher = createCoalescedRefresher(async () => {
    const requestGeneration = entry.generation;
    entry.latestStartedGeneration = requestGeneration;
    try {
      const response = await fetch("/api/portal-resident-tours", { credentials: "include" });
      if (!response.ok) return null;
      let body: { tours?: ResidentTourView[] };
      try {
        body = (await response.json()) as { tours?: ResidentTourView[] };
      } catch {
        return null;
      }
      if (!body || typeof body !== "object" || !Array.isArray(body.tours)) return null;
      const tours = body.tours;
      if (requestGeneration !== entry.generation) return null;
      entry.tours = tours;
      entry.refreshedAt = Date.now();
      return tours;
    } catch {
      return null;
    }
  });
  entries.set(key, entry);
  return entry;
}

/** Read resident tours once per viewer/email, sharing in-flight and fresh reads. */
export function loadResidentToursForViewer(
  userId: string,
  email: string,
  force = false,
): Promise<ResidentTourView[] | null> {
  if (!userId.trim() || !email.trim()) return Promise.resolve(null);
  const entry = entryFor(residentToursViewerKey(userId, email));
  if (!force && entry.tours && Date.now() - entry.refreshedAt < RESIDENT_TOURS_TTL_MS) {
    return Promise.resolve(entry.tours);
  }
  const needsPostInvalidationRun = entry.latestStartedGeneration < entry.generation;
  return entry.refresher.run(force || needsPostInvalidationRun);
}

/** Invalidate on a successful local tour write; other viewers remain isolated. */
export function notifyResidentToursChanged(): void {
  for (const entry of entries.values()) {
    entry.generation += 1;
    entry.refreshedAt = 0;
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(RESIDENT_TOURS_CHANGED_EVENT));
}
