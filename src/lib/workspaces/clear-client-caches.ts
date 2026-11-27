import { runWorkspaceCacheResets } from "@/lib/workspaces/workspace-cache-resets";

/**
 * sessionStorage record caches that are NOT keyed by workspace. A workspace switch (a full navigation for service
 * mode, a client navigation for the switcher) keeps the tab's sessionStorage, so the next workspace's first paint
 * would draw the previous one's rows. Preferences, drafts, auth hand-offs and the workspace list itself are not here.
 */
const WORKSPACE_SCOPED_SESSION_PREFIXES = [
  "axis_sched_cache_v1:",
  "axis_property_pipeline_cache_v1:",
  "axis:work-order-bids:",
  "axis:manager-work-orders:",
  "axis:manager-outgoing-expenses:",
  "axis:manager-promotions:",
  "axis:manager-vendors:",
  "axis:vendor-payouts:",
  "axis:portal-inbox:",
  "axis:lease-pipeline:",
  "axis:lease-pipeline-suppressed:",
  "axis:household-",
  "axis:manager-applications:",
];

/** localStorage record stores shared across the account's workspaces. */
const WORKSPACE_SCOPED_LOCAL_KEYS = ["axis_service_requests_v1"];

/**
 * Clear every browser cache that holds workspace-specific rows. Call it on EVERY workspace switch, before navigating.
 * Returns how many storage keys were removed.
 */
export function clearWorkspaceScopedClientCaches(): number {
  if (typeof window === "undefined") return 0;
  let removed = 0;
  try {
    for (const key of Object.keys(window.sessionStorage)) {
      if (!WORKSPACE_SCOPED_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
      window.sessionStorage.removeItem(key);
      removed += 1;
    }
  } catch {
    /* blocked storage */
  }
  try {
    for (const key of WORKSPACE_SCOPED_LOCAL_KEYS) {
      if (window.localStorage.getItem(key) === null) continue;
      window.localStorage.removeItem(key);
      removed += 1;
    }
  } catch {
    /* blocked storage */
  }
  runWorkspaceCacheResets();
  return removed;
}
