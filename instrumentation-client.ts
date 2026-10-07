import posthog from "posthog-js";
import {
  isProductionAnalyticsHost,
  prepareBrowserAnalyticsEvent,
} from "./src/lib/analytics/browser-performance";
import { runWhenIdle } from "./src/lib/run-when-idle";

function initPostHog(token: string): void {
  posthog.init(token, {
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

if (
  typeof window !== "undefined"
  && isProductionAnalyticsHost(window.location.hostname)
  && process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
) {
  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (window.location.pathname.startsWith("/auth")) {
    // Sign-in / account creation identify the user right away: init eagerly.
    initPostHog(token);
  } else {
    // Everywhere else analytics waits for the page to be interactive so it never competes with the
    // section's own requests. posthog-js sends the initial `$pageview` itself at the end of
    // `init()` (config `capture_pageview: "history_change"` from `defaults: "2026-01-30"`, a 1 ms
    // timer once the tab is visible), so a deferred init loses nothing and needs no manual capture
    // (adding one would double the first pageview). `track()` before init is a guarded no-op.
    runWhenIdle(() => initPostHog(token));
  }
}
