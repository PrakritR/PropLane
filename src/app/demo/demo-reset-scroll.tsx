"use client";

import { useEffect } from "react";
import { PORTAL_MAIN_CONTENT_ID } from "@/lib/portal-layout-classes";

/**
 * Forces `/demo` open scrolled to the very top of the Dashboard — KPI cards
 * first, not wherever a queue row happens to land. `#portal-main-content`
 * (the real portal's own scroll container, `DemoManagerShell`) is never
 * explicitly reset to the top on first mount by anything upstream, and as
 * async content (dynamic `ManagerDashboard` import, nav-count fetches,
 * workspace fetch) resizes the page above the fold, Chrome's scroll
 * anchoring can quietly walk the scroll position downward after the first
 * paint — which is what made the embed open looking like it had scrolled
 * partway down the dashboard. Disabling anchoring on the scroll container
 * plus a couple of scrollTop resets on the next frames closes both gaps
 * without touching the real portal shell components themselves.
 */
export function DemoResetScroll() {
  useEffect(() => {
    window.scrollTo(0, 0);

    const resetOnce = () => {
      const el = document.getElementById(PORTAL_MAIN_CONTENT_ID);
      if (!el) return false;
      el.style.overflowAnchor = "none";
      el.scrollTop = 0;
      return true;
    };

    resetOnce();
    const raf1 = requestAnimationFrame(() => {
      resetOnce();
      requestAnimationFrame(resetOnce);
    });
    const timers = [100, 400, 900].map((ms) => window.setTimeout(resetOnce, ms));

    return () => {
      cancelAnimationFrame(raf1);
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);

  return null;
}
