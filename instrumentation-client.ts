import posthog from "posthog-js";
import { sanitizeAnalyticsProperties } from "./src/lib/analytics/sanitize-event-properties";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",
  capture_exceptions: true,
  before_send: (event) => event
    ? { ...event, properties: sanitizeAnalyticsProperties(event.properties) }
    : null,
  debug: process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_POSTHOG_DEBUG === "true",
});
