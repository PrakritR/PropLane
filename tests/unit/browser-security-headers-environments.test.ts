import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("browser framing protections across deployment environments", () => {
  it.each([
    ["development", "development"],
    ["production", "preview"],
    ["production", "production"],
    ["test", "test"],
  ])("keeps same-origin framing and document previews under NODE_ENV=%s / VERCEL_ENV=%s", async (nodeEnv, vercelEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("VERCEL_ENV", vercelEnv);
    vi.resetModules();
    const { browserSecurityHeaders, buildBrowserSecurityHeaders } = await import("@/lib/security/browser-headers");
    const expected = [
      { key: "Content-Security-Policy", value: "base-uri 'self'; frame-ancestors 'self'; object-src 'self' blob: https://*.supabase.co https://*.supabase.in" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
    ];
    expect(buildBrowserSecurityHeaders()).toEqual(expected);
    expect(browserSecurityHeaders).toEqual(expected);
  });
});
