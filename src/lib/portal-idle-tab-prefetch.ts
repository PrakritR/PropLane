/**
 * Idle, once-per-session warm-up of the mobile bottom-tab routes.
 *
 * Background and per-link prefetch stay OFF on purpose
 * (`portal-nav-prefetch.ts`, commit f2cb04ac1): prefetch must never compete
 * with the tab the visitor just tapped. This is the narrow exception that keeps
 * that promise. It only starts after the current page has fully loaded and sat
 * quiet for a couple of seconds, it fetches one route per idle slot, it skips
 * metered / slow connections and hidden tabs, and a route is prefetched at most
 * once per page session - navigating never re-arms it.
 *
 * Production only: Turbopack recompiles each route on demand in dev, so warming
 * there just burns the dev server.
 */

export const IDLE_TAB_PREFETCH_DELAY_MS = 2000;

type NetworkInformationLike = { saveData?: boolean; effectiveType?: string };

const prefetchedHrefs = new Set<string>();

/** Test hook: forget what this page session already warmed. */
export function resetIdleTabPrefetchForTests(): void {
  prefetchedHrefs.clear();
}

export function idleTabPrefetchAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;
  if (document.visibilityState === "hidden") return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (connection?.saveData) return false;
  if (connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return false;
  return true;
}

type IdleScheduler = (run: () => void) => void;

function defaultIdle(run: () => void): void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(run, { timeout: 5000 });
    return;
  }
  window.setTimeout(run, 250);
}

/**
 * Warm `hrefs` one idle slot at a time. Returns a cancel function (call it from
 * the effect cleanup). `prefetch` is `router.prefetch` or a wrapper.
 */
export function scheduleIdleTabPrefetch(
  hrefs: readonly string[],
  prefetch: (href: string) => void,
  options: { delayMs?: number; idle?: IdleScheduler } = {},
): () => void {
  if (typeof window === "undefined" || process.env.NODE_ENV !== "production") return () => undefined;
  const pending = [...new Set(hrefs)].filter((href) => href && !prefetchedHrefs.has(href));
  if (pending.length === 0) return () => undefined;

  const delayMs = options.delayMs ?? IDLE_TAB_PREFETCH_DELAY_MS;
  const idle = options.idle ?? defaultIdle;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const warmNext = () => {
    if (cancelled) return;
    if (!idleTabPrefetchAllowed()) return; // hidden / save-data / slow: do nothing, never retry
    const href = pending.shift();
    if (!href) return;
    if (!prefetchedHrefs.has(href)) {
      prefetchedHrefs.add(href);
      try {
        prefetch(href);
      } catch {
        /* prefetch is best-effort */
      }
    }
    if (pending.length > 0) idle(warmNext);
  };

  const start = () => {
    if (cancelled) return;
    timer = setTimeout(() => idle(warmNext), delayMs);
  };

  // "After the page has painted": wait for the window load event first.
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener("load", start);
  };
}
