"use client";

import posthog from "posthog-js";
import { useEffect, useRef } from "react";

import {
  analyticsRouteFromUrl,
  isProductionAnalyticsHost,
  navigationTimingSnapshot,
  nativeRuntimeMetadata,
} from "@/lib/analytics/browser-performance";

/** Records one coarse navigation-timing sample without adding another vitals collector. */
export function NavigationTiming() {
  const reported = useRef(false);

  useEffect(() => {
    if (reported.current || !isProductionAnalyticsHost(window.location.hostname)) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const pathname = entry ? analyticsRouteFromUrl(entry.name) : null;
      if (!entry || !pathname || reported.current) return;
      const timing = Object.fromEntries(
        Object.entries(navigationTimingSnapshot(entry)).filter(([, value]) => value > 0),
      );
      if (Object.keys(timing).length === 0) return;
      reported.current = true;
      try {
        posthog.capture("navigation_timing", {
          ...timing,
          pathname,
          ...nativeRuntimeMetadata(document.documentElement.getAttribute("data-native")),
        });
      } catch {
        /* Analytics must never affect navigation. */
      }
    };
    const onLoad = () => {
      timeout = window.setTimeout(report, 0);
    };

    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => {
      window.removeEventListener("load", onLoad);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, []);

  return null;
}
