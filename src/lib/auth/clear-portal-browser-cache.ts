import { resetPropertyPipelineClientCache } from "@/lib/demo-property-pipeline";

/** Keys written by portal sync loaders, prefs, and demo caches — not Supabase auth tokens. */
const CACHE_KEY_RE = /^(axis[:_]|propplane\.|proplane_)/i;

function shouldClearStorageKey(key: string): boolean {
  return CACHE_KEY_RE.test(key);
}

/**
 * Drop client-side portal caches after a dev DB wipe. Server wipe cannot reach
 * localStorage/sessionStorage; stale rows here made a fresh DB look populated.
 */
export function clearPortalBrowserCache(): number {
  if (typeof window === "undefined") return 0;
  let removed = 0;
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (!shouldClearStorageKey(key)) continue;
      window.localStorage.removeItem(key);
      removed += 1;
    }
    for (const key of Object.keys(window.sessionStorage)) {
      if (!shouldClearStorageKey(key)) continue;
      window.sessionStorage.removeItem(key);
      removed += 1;
    }
  } catch {
    /* blocked storage — nothing to clear */
  }
  resetPropertyPipelineClientCache();
  return removed;
}

export function isLocalDevHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}
