"use client";

import { portalBackgroundPrefetchEnabled } from "@/lib/portal-nav-prefetch";
import { DEMO_NAVIGATE_EVENT, isDemoModeActive } from "@/lib/demo/demo-session";
import { useRouter } from "next/navigation";
import { startTransition, useCallback, type MouseEvent } from "react";

/** First path segment ("portal", "admin", "resident", ...) — identifies which portal a path belongs to. */
function portalRootSegment(path: string): string {
  return path.split("?")[0]?.split("/").filter(Boolean)[0] ?? "";
}

/**
 * True only when `href` leaves the portal `fromPathname` is currently in (e.g.
 * /admin/* -> /portal/*). Tab switches within the same portal never need a full
 * reload — that's what caused the native app's black-screen flash between tabs.
 */
export function isCrossPortalNavigation(fromPathname: string, href: string): boolean {
  return portalRootSegment(fromPathname) !== portalRootSegment(href);
}

/** Smooth client navigation — keeps modified clicks (new tab, etc.) on the native link. */
export function portalNavClick(
  router: ReturnType<typeof useRouter>,
  href: string,
  options?: { preferFullNavigation?: boolean },
) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (isDemoModeActive()) {
      window.dispatchEvent(new CustomEvent(DEMO_NAVIGATE_EVENT, { detail: { href } }));
      return;
    }
    if (options?.preferFullNavigation) {
      window.location.assign(href);
      return;
    }
    startTransition(() => {
      router.push(href);
    });
  };
}

export function prefetchPortalHref(router: ReturnType<typeof useRouter>, href: string) {
  if (!portalBackgroundPrefetchEnabled()) return;
  try {
    router.prefetch(href);
  } catch {
    /* prefetch is best-effort */
  }
}

/**
 * `replace: true` swaps the current history entry instead of adding one. Use it
 * for navigation the visitor did not ask for — a panel resolving a link into the
 * specific record that link actually meant, say. Pushing there leaves an entry
 * they never chose, so Back returns them to the page that immediately sends them
 * forward again, and the trip reads as the app navigating on its own.
 *
 * An OPTION rather than a second exported hook on purpose: a new export has to
 * be added to every partial `vi.mock("@/lib/portal-nav-client", …)` in the suite
 * or the panels under those tests crash on an undefined hook, and there are
 * dozens of them.
 */
export type PortalNavigateOptions = { replace?: boolean };

export function usePortalNavigate() {
  const router = useRouter();
  return useCallback((href: string, options?: PortalNavigateOptions) => {
    // Reused portal panels also render inside the public /demo sandbox where a
    // real route push would hit the auth-gated portal layout and bounce the
    // visitor to /auth/sign-in. In demo mode, hand the target to the demo shell
    // to resolve as an in-sandbox section switch instead.
    if (isDemoModeActive()) {
      window.dispatchEvent(new CustomEvent(DEMO_NAVIGATE_EVENT, { detail: { href } }));
      return;
    }
    startTransition(() => (options?.replace ? router.replace(href) : router.push(href)));
  }, [router]);
}
