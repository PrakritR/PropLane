"use client";

/**
 * Client-side cache for the account-level `GET /api/portal/automation-settings`
 * read, following the same TTL + in-flight guard shape the other portal sync
 * helpers already use (see `src/lib/manager-vendors-storage.ts`).
 *
 * Several sibling widgets on one manager page each want these settings on
 * mount — e.g. every `PortalNotificationPreviewModal` instance on
 * `ManagerResidents` is always mounted (only `open` toggles visibility), and
 * each one calls `useManagerCommunicationDeliverVia()` independently. Without
 * a shared cache that was 4-6 identical GETs per page load at ~2.3-2.5s each,
 * warm, driving an 11.2s total load (Night QA finding #2). Every caller here
 * shares one request per TTL window, keyed by the signed-in manager.
 */
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS, type ManagerAutomationSettings } from "@/lib/payment-automation-settings";

const TTL_MS = 15_000;

type CacheEntry = {
  promise: Promise<ManagerAutomationSettings> | null;
  value: ManagerAutomationSettings | null;
  fetchedAt: number;
};

const cacheByUserId = new Map<string, CacheEntry>();

async function fetchManagerAutomationSettings(): Promise<ManagerAutomationSettings> {
  const res = await fetch("/api/portal/automation-settings", { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(`automation-settings ${res.status}`);
  const body = (await res.json()) as { settings?: ManagerAutomationSettings };
  return body.settings ?? DEFAULT_MANAGER_AUTOMATION_SETTINGS;
}

/**
 * `force: true` (e.g. after a settings save, or the `PAYMENT_AUTOMATION_SETTINGS_EVENT`
 * listener) always starts a fresh fetch, bypassing both the TTL and any
 * in-flight join — the same freshness contract `createCoalescedRefresher`
 * documents. An unforced caller inside the TTL window gets the cached value
 * synchronously (still async-returned); one inside the window but before the
 * first fetch has resolved joins that in-flight request instead of starting
 * a second one.
 */
export function loadManagerAutomationSettingsCached(
  userId: string,
  opts?: { force?: boolean },
): Promise<ManagerAutomationSettings> {
  const force = opts?.force === true;
  let entry = cacheByUserId.get(userId);
  if (!entry) {
    entry = { promise: null, value: null, fetchedAt: 0 };
    cacheByUserId.set(userId, entry);
  }
  if (!force && entry.value !== null && Date.now() - entry.fetchedAt < TTL_MS) {
    return Promise.resolve(entry.value);
  }
  if (!force && entry.promise) return entry.promise;

  const current = entry;
  const promise = fetchManagerAutomationSettings()
    .then((settings) => {
      current.value = settings;
      current.fetchedAt = Date.now();
      return settings;
    })
    .finally(() => {
      if (current.promise === promise) current.promise = null;
    });
  current.promise = promise;
  return promise;
}

/** Test/debug hook, and used after a save so the next read is guaranteed fresh. */
export function invalidateManagerAutomationSettingsCache(userId?: string): void {
  if (userId) cacheByUserId.delete(userId);
  else cacheByUserId.clear();
}
