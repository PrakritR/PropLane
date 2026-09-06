import { describe, expect, it } from "vitest";
import { sanitizeAnalyticsProperties } from "@/lib/analytics/sanitize-event-properties";

describe("analytics bearer URL redaction", () => {
  it("scrubs current, referrer, previous and autocaptured nested href properties", () => {
    const url = "https://prop-lane.space/auth/co-manager-invite?token=secret-value";
    const event = { $current_url: url, $referrer: url, $prev_pageview_pathname: url, $elements: [{ attr__href: url }] };
    const result = sanitizeAnalyticsProperties(event);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(result.$current_url).toBe("https://prop-lane.space/auth/co-manager-invite?[redacted]");
    expect(event.$current_url).toBe(url);
  });
  it("scrubs nested and repeatedly encoded next redirects", () => {
    const target = "/auth/co-manager-invite?token=secret-value";
    for (const next of [encodeURIComponent(target), encodeURIComponent(encodeURIComponent(target))]) {
      expect(sanitizeAnalyticsProperties(`/auth/sign-in?next=${next}`)).toBe("/auth/sign-in?[redacted]");
    }
  });
  it("scrubs fragment credentials and the legacy invite path", () => {
    expect(sanitizeAnalyticsProperties("https://example.com/auth#access_token=secret-value")).not.toContain("secret-value");
    expect(sanitizeAnalyticsProperties("https://example.com/invite/secret-value")).toBe("https://example.com/invite/[redacted]?[redacted]");
  });
  it("preserves non-sensitive analytics properties and ordinary routes", () => {
    const props = { $current_url: "https://example.com/portal/teams?tab=managers", count: 2, active: true, error: null, id: "a" };
    expect(sanitizeAnalyticsProperties(props)).toEqual(props);
  });
});
