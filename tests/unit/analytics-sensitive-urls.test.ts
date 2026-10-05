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
  describe("linked-form share links (/f/<token>)", () => {
    const token = "Abc123_-xyzABC123_-xyzABC123_-xyzABC12345";
    it("redacts the token in the path of every URL-valued property", () => {
      const url = `https://prop-lane.space/f/${token}`;
      const event = { $current_url: url, $pathname: `/f/${token}`, $referrer: url, $prev_pageview_pathname: `/f/${token}`, $elements: [{ attr__href: `/f/${token}` }] };
      const result = sanitizeAnalyticsProperties(event);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(result.$current_url).toBe("https://prop-lane.space/f/[redacted]");
      expect(result.$pathname).toBe("/f/[redacted]");
      expect(result.$elements[0]!.attr__href).toBe("/f/[redacted]");
    });
    it("redacts it with a query or fragment too, keeping the removed-query marker", () => {
      expect(sanitizeAnalyticsProperties(`/f/${token}?utm_source=mail`)).toBe("/f/[redacted]?[redacted]");
      expect(sanitizeAnalyticsProperties(`https://x.test/f/${token}#frag`)).toBe("https://x.test/f/[redacted]?[redacted]");
    });
    it("redacts a sign-in redirect that carries the share path, plain or encoded any number of times", () => {
      const target = `/f/${token}`;
      for (const next of [target, encodeURIComponent(target), encodeURIComponent(encodeURIComponent(target)), `%2Ff%2F${token}`]) {
        const result = sanitizeAnalyticsProperties(`/auth/sign-in?next=${next}`);
        expect(result).not.toContain(token);
        expect(result).toBe("/auth/sign-in?[redacted]");
      }
      expect(sanitizeAnalyticsProperties(`https://x.test/auth/sign-in?next=%2Ff%2F${token}&foo=1`)).not.toContain(token);
    });
    it("leaves the session-scoped /f/open/<request id> page readable", () => {
      const open = "/f/open/44444444-4444-4444-8444-444444444444";
      expect(sanitizeAnalyticsProperties(open)).toBe(open);
      expect(sanitizeAnalyticsProperties(`https://x.test${open}?fee=cancel`)).toBe(`https://x.test${open}?fee=cancel`);
      expect(sanitizeAnalyticsProperties("/f/open")).toBe("/f/open");
    });
    it("does not redact ordinary routes that merely contain /f", () => {
      for (const route of ["/portal/files", "/f/short", "/pdf/abcdefghijklmnopqrstuvwxyz"]) {
        expect(sanitizeAnalyticsProperties(route)).toBe(route);
      }
    });
  });
  it("preserves non-sensitive analytics properties and ordinary routes", () => {
    const props = { $current_url: "https://example.com/portal/teams?tab=managers", count: 2, active: true, error: null, id: "a" };
    expect(sanitizeAnalyticsProperties(props)).toEqual(props);
  });
});
