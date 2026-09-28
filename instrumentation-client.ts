import posthog from "posthog-js";
import {
  isProductionAnalyticsHost,
  prepareBrowserAnalyticsEvent,
} from "./src/lib/analytics/browser-performance";

if (
  typeof window !== "undefined"
  && isProductionAnalyticsHost(window.location.hostname)
  && process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-01-30",
    capture_exceptions: true,
    before_send: (event) => prepareBrowserAnalyticsEvent(
      event,
      document.documentElement.getAttribute("data-native"),
    ),
    debug: process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_POSTHOG_DEBUG === "true",
  });
}
