"use client";

/**
 * Client-side cache for the `GET /api/portal/automation-settings` read, keyed
 * by viewer + scope (workspace/property) and built on `createCoalescedRefresher`
 * (`src/lib/coalesced-refresh.ts`) plus the same TTL + in-flight guard shape
 * the other portal sync helpers use (see `src/lib/manager-vendors-storage.ts`).
 *
 * Several sibling widgets on one manager page each want these settings on
 * mount — e.g. every `PortalNotificationPreviewModal` instance on
 * `ManagerResidents` is always mounted (only `open` toggles visibility), and
 * each one calls `useManagerCommunicationDeliverVia()` independently. The
 * Settings modal alone mounts several more readers (tour settings, messaging
 * defaults, notification routing, the property-override editor, and a
 * handful of single-field toggle rows). Without a shared cache that was N
 * identical GETs per page load at ~2.3-2.5s each, warm (Night QA finding #2).
 * Every caller here shares one request per key per TTL window.
 *
 * A write always calls `/api/portal/automation-settings` with `PATCH` and,
 * on success, dispatches `PAYMENT_AUTOMATION_SETTINGS_EVENT` on `window` —
 * every save path already does this for its own local state. This module
 * listens for that event and clears the WHOLE cache (every key), so a save
 * under any scope is reflected by the very next read anywhere, without
 * requiring every write call site to know which cache keys to invalidate.
 */
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS, PAYMENT_AUTOMATION_SETTINGS_EVENT, type ManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";

/** "account" | "workspace" | "property" — mirrors `SettingsResolutionSource` (settings-property-scope.tsx) without a cross-import of a client component file. */
export type ManagerAutomationSettingsSource = "account" | "workspace" | "property";

export type ManagerAutomationSettingsLoad = {
  settings: ManagerAutomationSettings;
  source: ManagerAutomationSettingsSource | null;
};

const TTL_MS = 15_000;

type CacheEntry = {
  refresher: CoalescedRefresher<ManagerAutomationSettingsLoad>;
  value: ManagerAutomationSettingsLoad | null;
  fetchedAt: number;
};

const cacheByKey = new Map<string, CacheEntry>();

function cacheKey(userId: string, workspaceId?: string | null, propertyId?: string | null): string {
  return `${userId}::${workspaceId?.trim() || ""}::${propertyId?.trim() || ""}`;
}

async function fetchManagerAutomationSettings(
  workspaceId?: string | null,
  propertyId?: string | null,
): Promise<ManagerAutomationSettingsLoad> {
  const params = new URLSearchParams();
  if (propertyId) params.set("propertyId", propertyId);
  if (workspaceId) params.set("workspaceId", workspaceId);
  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`/api/portal/automation-settings${query}`, { credentials: "include", cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as {
    settings?: ManagerAutomationSettings;
    source?: ManagerAutomationSettingsSource;
    error?: string;
  };
  // Every direct-fetch call site this reader replaces surfaced the server's
  // own error string (e.g. "Unauthorized.") in its toast — preserve that
  // instead of a generic status-code message.
  if (!res.ok) throw new Error(body.error || `automation-settings ${res.status}`);
  return { settings: body.settings ?? DEFAULT_MANAGER_AUTOMATION_SETTINGS, source: body.source ?? null };
}

function entryFor(key: string, workspaceId?: string | null, propertyId?: string | null): CacheEntry {
  let entry = cacheByKey.get(key);
  if (!entry) {
    entry = {
      refresher: createCoalescedRefresher(() => fetchManagerAutomationSettings(workspaceId, propertyId)),
      value: null,
      fetchedAt: 0,
    };
    cacheByKey.set(key, entry);
  }
  return entry;
}

/**
 * `force: true` (e.g. after a settings save, or the `PAYMENT_AUTOMATION_SETTINGS_EVENT`
 * listener) always starts a run that begins after this call — the same
 * freshness contract `createCoalescedRefresher` documents. An unforced caller
 * inside the TTL window gets the cached value synchronously (still
 * async-returned); one inside the window but before the first fetch has
 * resolved joins that in-flight request instead of starting a second one.
 *
 * `workspaceId` / `propertyId` scope the read exactly like the route's own
 * `?workspaceId=` / `?propertyId=` query params, and key the cache entry —
 * two callers asking for different scopes never share a request or a value.
 */
export function loadManagerAutomationSettingsCached(
  userId: string,
  opts?: { workspaceId?: string | null; propertyId?: string | null; force?: boolean },
): Promise<ManagerAutomationSettingsLoad> {
  const workspaceId = opts?.workspaceId ?? null;
  const propertyId = opts?.propertyId ?? null;
  const force = opts?.force === true;
  const key = cacheKey(userId, workspaceId, propertyId);
  const entry = entryFor(key, workspaceId, propertyId);

  if (!force && entry.value !== null && Date.now() - entry.fetchedAt < TTL_MS) {
    return Promise.resolve(entry.value);
  }

  return entry.refresher.run(force).then((loaded) => {
    entry.value = loaded;
    entry.fetchedAt = Date.now();
    return loaded;
  });
}

/** Test/debug hook, and used after a save so the next read (any scope) is guaranteed fresh. */
export function invalidateManagerAutomationSettingsCache(userId?: string): void {
  if (!userId) {
    cacheByKey.clear();
    return;
  }
  for (const key of [...cacheByKey.keys()]) {
    if (key.startsWith(`${userId}::`)) cacheByKey.delete(key);
  }
}

if (typeof window !== "undefined") {
  // Every save path already dispatches this event for its own local state
  // (see e.g. `pro-messaging-outbound-defaults.tsx`, `pro-portal-settings-panels.tsx`);
  // piggybacking here means a write under any scope invalidates every reader
  // without each save call site needing to know which cache keys to drop.
  window.addEventListener(PAYMENT_AUTOMATION_SETTINGS_EVENT, () => invalidateManagerAutomationSettingsCache());
}
