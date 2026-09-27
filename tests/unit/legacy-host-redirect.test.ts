import { afterEach, describe, expect, it } from "vitest";
import {
  isLegacyRedirectHost,
  isNativeShellEntryPath,
  isNativeWebViewUserAgent,
  isTopLevelDocumentNavigation,
  legacyHostCanonicalRedirectUrl,
  NATIVE_SESSION_MARKER_COOKIE,
  shouldRedirectLegacyHostVisitor,
} from "@/lib/legacy-host-redirect";

const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPHONE_IN_APP_WEBVIEW_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function headersFrom(record: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

describe("isLegacyRedirectHost", () => {
  it("matches every legacy host and its www variant, case- and port-insensitive", () => {
    expect(isLegacyRedirectHost("prop-lane.space")).toBe(true);
    expect(isLegacyRedirectHost("www.prop-lane.space")).toBe(true);
    expect(isLegacyRedirectHost("proplane.space")).toBe(true);
    expect(isLegacyRedirectHost("www.proplane.space")).toBe(true);
    expect(isLegacyRedirectHost("axis-seattle-housing.com")).toBe(true);
    expect(isLegacyRedirectHost("www.axis-seattle-housing.com")).toBe(true);
    expect(isLegacyRedirectHost("WWW.PROP-LANE.SPACE:443")).toBe(true);
  });

  it("never matches the canonical, staging, preview, or local hosts", () => {
    expect(isLegacyRedirectHost("proplane.ai")).toBe(false);
    expect(isLegacyRedirectHost("www.proplane.ai")).toBe(false);
    expect(isLegacyRedirectHost("staging-prop-lane.space")).toBe(false);
    expect(isLegacyRedirectHost("staging.prop-lane.space")).toBe(false);
    expect(isLegacyRedirectHost("my-branch-git-foo.vercel.app")).toBe(false);
    expect(isLegacyRedirectHost("localhost")).toBe(false);
    expect(isLegacyRedirectHost("localhost:3000")).toBe(false);
  });
});

describe("isTopLevelDocumentNavigation", () => {
  it("is true for sec-fetch-dest: document", () => {
    expect(isTopLevelDocumentNavigation(headersFrom({ "sec-fetch-dest": "document" }))).toBe(true);
  });

  it("is true for sec-fetch-mode: navigate even without sec-fetch-dest", () => {
    expect(isTopLevelDocumentNavigation(headersFrom({ "sec-fetch-mode": "navigate" }))).toBe(true);
  });

  it("is false for a subresource or fetch/XHR request", () => {
    expect(isTopLevelDocumentNavigation(headersFrom({ "sec-fetch-dest": "image" }))).toBe(false);
    expect(
      isTopLevelDocumentNavigation(headersFrom({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" })),
    ).toBe(false);
  });

  it("is false when neither header is present (no evidence, never assume browser)", () => {
    expect(isTopLevelDocumentNavigation(headersFrom({}))).toBe(false);
  });
});

describe("isNativeWebViewUserAgent", () => {
  it("is false for real Safari on iPhone (carries the Safari/ token)", () => {
    expect(isNativeWebViewUserAgent(IPHONE_SAFARI_UA)).toBe(false);
  });

  it("is true for an iPhone AppleWebKit UA missing the Safari/ token", () => {
    expect(isNativeWebViewUserAgent(IPHONE_IN_APP_WEBVIEW_UA)).toBe(true);
  });

  it("is true for any UA carrying a Capacitor token, regardless of platform", () => {
    expect(isNativeWebViewUserAgent(`${ANDROID_CHROME_UA} CapacitorHttp`)).toBe(true);
  });

  it("is false for Android Chrome and empty UAs", () => {
    expect(isNativeWebViewUserAgent(ANDROID_CHROME_UA)).toBe(false);
    expect(isNativeWebViewUserAgent("")).toBe(false);
  });
});

describe("isNativeShellEntryPath", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("matches the default native entry path and its sub-paths", () => {
    expect(isNativeShellEntryPath("/auth/sign-in")).toBe(true);
    expect(isNativeShellEntryPath("/auth/sign-in/")).toBe(true);
    expect(isNativeShellEntryPath("/auth/sign-in/anything")).toBe(true);
  });

  it("does not match an unrelated path", () => {
    expect(isNativeShellEntryPath("/portal/dashboard")).toBe(false);
    expect(isNativeShellEntryPath("/auth/sign-in-typo")).toBe(false);
  });

  it("follows a CAP_NATIVE_ENTRY override", () => {
    process.env.CAP_NATIVE_ENTRY = "/auth/welcome";
    expect(isNativeShellEntryPath("/auth/welcome")).toBe(true);
    expect(isNativeShellEntryPath("/auth/sign-in")).toBe(false);
  });
});

describe("shouldRedirectLegacyHostVisitor", () => {
  function baseSignals(overrides: Partial<Parameters<typeof shouldRedirectLegacyHostVisitor>[0]> = {}) {
    return {
      pathname: "/rent/listing-123",
      method: "GET",
      hostname: "prop-lane.space",
      headers: headersFrom({ "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 (Windows NT 10.0)" }),
      hasNativeMarkerCookie: false,
      ...overrides,
    };
  }

  it("redirects a plain browser top-level navigation to a legacy host", () => {
    expect(shouldRedirectLegacyHostVisitor(baseSignals())).toBe(true);
  });

  it("redirects every legacy host and www variant", () => {
    for (const hostname of [
      "prop-lane.space",
      "www.prop-lane.space",
      "proplane.space",
      "www.proplane.space",
      "axis-seattle-housing.com",
      "www.axis-seattle-housing.com",
    ]) {
      expect(shouldRedirectLegacyHostVisitor(baseSignals({ hostname }))).toBe(true);
    }
  });

  it("never redirects the canonical, staging, preview, or local hosts", () => {
    for (const hostname of ["proplane.ai", "staging-prop-lane.space", "foo.vercel.app", "localhost"]) {
      expect(shouldRedirectLegacyHostVisitor(baseSignals({ hostname }))).toBe(false);
    }
  });

  it("never redirects /api/**", () => {
    expect(shouldRedirectLegacyHostVisitor(baseSignals({ pathname: "/api/cron/webhook-deliveries" }))).toBe(
      false,
    );
  });

  it("never redirects a non-GET/HEAD request (webhooks, form posts)", () => {
    expect(shouldRedirectLegacyHostVisitor(baseSignals({ method: "POST" }))).toBe(false);
    expect(shouldRedirectLegacyHostVisitor(baseSignals({ method: "PUT" }))).toBe(false);
  });

  it("allows HEAD alongside GET", () => {
    expect(shouldRedirectLegacyHostVisitor(baseSignals({ method: "HEAD" }))).toBe(true);
  });

  it("never redirects a subresource/fetch request (no document navigation evidence)", () => {
    expect(
      shouldRedirectLegacyHostVisitor(
        baseSignals({ headers: headersFrom({ "sec-fetch-dest": "image" }) }),
      ),
    ).toBe(false);
    expect(shouldRedirectLegacyHostVisitor(baseSignals({ headers: headersFrom({}) }))).toBe(false);
  });

  it("never redirects a request carrying the native marker cookie", () => {
    expect(shouldRedirectLegacyHostVisitor(baseSignals({ hasNativeMarkerCookie: true }))).toBe(false);
  });

  it("never redirects the native shell's entry path", () => {
    expect(shouldRedirectLegacyHostVisitor(baseSignals({ pathname: "/auth/sign-in" }))).toBe(false);
  });

  it("never redirects an in-app WebView user agent", () => {
    expect(
      shouldRedirectLegacyHostVisitor(
        baseSignals({
          headers: headersFrom({ "sec-fetch-dest": "document", "user-agent": IPHONE_IN_APP_WEBVIEW_UA }),
        }),
      ),
    ).toBe(false);
  });

  it("still redirects a real Safari browser on an iPhone", () => {
    expect(
      shouldRedirectLegacyHostVisitor(
        baseSignals({
          headers: headersFrom({ "sec-fetch-dest": "document", "user-agent": IPHONE_SAFARI_UA }),
        }),
      ),
    ).toBe(true);
  });
});

describe("legacyHostCanonicalRedirectUrl", () => {
  it("preserves the path and query on the canonical origin", () => {
    expect(legacyHostCanonicalRedirectUrl("/rent/listing-123", "?utm_source=ad")).toBe(
      "https://proplane.ai/rent/listing-123?utm_source=ad",
    );
  });

  it("handles the root path with no query", () => {
    expect(legacyHostCanonicalRedirectUrl("/", "")).toBe("https://proplane.ai/");
  });
});

describe("NATIVE_SESSION_MARKER_COOKIE", () => {
  it("is a stable cookie name", () => {
    expect(NATIVE_SESSION_MARKER_COOKIE).toBe("proplane_native");
  });
});
