import { resetPropertyPipelineClientCache } from "@/lib/demo-property-pipeline";

/** Keys written by portal sync loaders, prefs, and demo caches — not Supabase auth tokens. */
const CACHE_KEY_RE = /^(axis[:_]|propplane\.|proplane[_.:])/i;

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
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[area];
      for (const key of Object.keys(storage)) {
        if (!shouldClearStorageKey(key)) continue;
        storage.removeItem(key);
        removed += 1;
      }
    } catch {
      /* A blocked storage area must not prevent clearing the other. */
    }
  }
  resetPropertyPipelineClientCache();
  return removed;
}

export function isLocalDevHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}
