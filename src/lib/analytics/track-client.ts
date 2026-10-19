/**
 * Client-side PostHog product analytics. The browser counterpart to the
 * server-side `track()` in `./posthog.ts`.
 *
 * PostHog is initialized once in `instrumentation-client.ts` and identifies the
 * user on sign-in, so the distinct id is implicit here — callers only pass the
 * event name and non-PII properties. No-ops safely when PostHog isn't loaded
 * (token unset, SSR, ad-blocked), so it is safe to call from any component.
 *
 * Convention: `object_action` names (e.g. `charge_created`), reuse existing
 * names, never pass PII or secrets. See the PostHog section in AGENTS.md.
 */
import { isProductionAnalyticsHost } from "@/lib/analytics/browser-performance";

export function track(
  event: string,
  properties?: Record<string, string | number | boolean | undefined>,
): void {
  try {
    if (typeof window === "undefined" || !isProductionAnalyticsHost(window.location.hostname)
      || !process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) return;
    void import("posthog-js").then(({ default: posthog }) => {
      posthog.capture(event, properties);
    }).catch(() => { /* Analytics must never break the UI. */ });
  } catch {
    /* analytics must never break the UI */
  }
}
