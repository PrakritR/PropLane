import { isProductionBrowserAnalyticsHost } from "@/lib/seo/public-crawl-host";

import { sanitizeAnalyticsProperties } from "./sanitize-event-properties";

type AnalyticsProperties = Record<string, unknown>;

type BrowserAnalyticsEvent = {
  event?: string;
  properties?: AnalyticsProperties;
};

export function isProductionAnalyticsHost(hostname: string): boolean {
  return isProductionBrowserAnalyticsHost(hostname);
}

export function analyticsRouteFromUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value, "https://proplane.ai");
    const route = sanitizeAnalyticsProperties(`${parsed.origin}${parsed.pathname}`);
    return new URL(route).pathname;
  } catch {
    return null;
  }
}

function navigationRoute(properties: AnalyticsProperties): string | null {
  const metricFields = [
    "$web_vitals_LCP_event",
    "$web_vitals_FCP_event",
    "$web_vitals_INP_event",
    "$web_vitals_CLS_event",
    "$web_vitals_TTFB_event",
  ];
  for (const field of metricFields) {
    const value = properties[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const navigationURL = (value as { navigationURL?: unknown }).navigationURL;
    const route = analyticsRouteFromUrl(navigationURL);
    if (route) return route;
  }
  return null;
}

export function nativeRuntimeMetadata(nativePlatform: string | null | undefined): {
  axis_runtime: "web" | "native-ios" | "native-android" | "native";
} {
  if (nativePlatform === "ios") return { axis_runtime: "native-ios" };
  if (nativePlatform === "android") return { axis_runtime: "native-android" };
  if (nativePlatform) return { axis_runtime: "native" };
  return { axis_runtime: "web" };
}

/**
 * Keeps PostHog's built-in single web-vitals event, but attributes that event
 * to the navigation which created the metric rather than a later SPA route.
 */
export function prepareBrowserAnalyticsEvent<T extends BrowserAnalyticsEvent>(
  event: T | null,
  nativePlatform: string | null | undefined,
): T | null {
  if (!event) return null;
  const properties = sanitizeAnalyticsProperties(event.properties ?? {});
  const runtime = nativeRuntimeMetadata(nativePlatform);

  if (event.event !== "$web_vitals") {
    return { ...event, properties: { ...properties, ...runtime } };
  }

  const route = navigationRoute(properties);
  if (!route) return { ...event, properties: { ...properties, ...runtime } };

  const currentUrl = typeof properties.$current_url === "string" ? properties.$current_url : "";
  let attributedUrl = route;
  try {
    attributedUrl = new URL(route, currentUrl || "https://proplane.ai").toString();
  } catch {
    // The path itself remains useful if a browser extension supplied a malformed URL.
  }

  return {
    ...event,
    properties: {
      ...properties,
      ...runtime,
      $current_url: attributedUrl,
      $pathname: route,
      axis_web_vitals_navigation_path: route,
    },
  };
}

export type NavigationTimingSnapshot = {
  duration: number;
  responseStart: number;
  domContentLoaded: number;
};

export function navigationTimingSnapshot(entry: PerformanceNavigationTiming): NavigationTimingSnapshot {
  return {
    duration: Math.round(entry.duration),
    responseStart: Math.round(entry.responseStart),
    domContentLoaded: Math.round(entry.domContentLoadedEventEnd),
  };
}
