"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * A record page's phone sticky action bar replaces the bottom nav bar while
 * that page is mounted (PLAN-0920-1058, no-bottom-bar) — two fixed bars at the
 * bottom of a 390px screen never both fit. `PortalSidebar` renders the bottom
 * nav bar as a sibling of the page content (see `src/app/portal/layout.tsx`),
 * so a page cannot just render `display:none` on it; this is a tiny global
 * store instead of a React context so no layout file needs to change to wire
 * a provider through it. A count, not a boolean, so a record page that itself
 * nests another hider (unlikely, but cheap to make safe) does not un-hide the
 * bar on the inner one's unmount while the outer one is still mounted.
 */
let hideCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Call from a record page's chrome while it is mounted; unmounting restores the bar. */
export function useHideBottomNavWhileMounted(hidden = true): void {
  useEffect(() => {
    if (!hidden) return;
    hideCount += 1;
    emit();
    return () => {
      hideCount -= 1;
      emit();
    };
  }, [hidden]);
}

/** Read by `PortalSidebar`'s bottom-nav-bar visibility check. */
export function useBottomNavHidden(): boolean {
  return useSyncExternalStore(subscribe, () => hideCount > 0, () => false);
}
