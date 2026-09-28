"use client";

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function readSystemPreference(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * ONE hook every animated primitive in `src/components/ui/motion/` (and every
 * component that adopts one) reads, instead of re-deriving the `motion-reduce:`
 * Tailwind variant per component. Mirrors the OS `prefers-reduced-motion`
 * setting and updates live if the operator flips it while the page is open.
 *
 * SSR-safe: server render always returns `false` (matching the CSS media
 * query's own default), then syncs to the real value on mount — the same
 * hydration-safe shape `useIsClient` uses elsewhere in this codebase.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(QUERY);
    setReduced(mql.matches);
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

/**
 * Non-hook escape hatch for code that isn't a component render (an event
 * handler building a DOM clone, a one-off `setTimeout`). Never use this in a
 * render body — it won't re-render on change, `useReducedMotion()` is for that.
 */
export function prefersReducedMotionNow(): boolean {
  return readSystemPreference();
}
