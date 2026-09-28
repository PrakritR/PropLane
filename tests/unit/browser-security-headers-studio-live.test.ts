import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The dev-only studio-live frame-ancestors relaxation (docs/agents/studio-live.md).
 * Production and preview builds run `next build` with NODE_ENV=production
 * regardless of Vercel target, so gating on NODE_ENV alone keeps both byte-identical
 * to the pre-studio header set. Only a local `next dev` (NODE_ENV=development)
 * gets the extra frame-ancestors origins and drops X-Frame-Options.
 */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

async function headersFor(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  const { buildBrowserSecurityHeaders } = await import("@/lib/security/browser-headers");
  return buildBrowserSecurityHeaders();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", ORIGINAL_NODE_ENV ?? "test");
  vi.resetModules();
});

describe("browserSecurityHeaders — production", () => {
  it("keeps the exact pre-studio CSP and X-Frame-Options", async () => {
    const headers = await headersFor("production");
    expect(headers).toEqual([
      {
        key: "Content-Security-Policy",
        value: "base-uri 'self'; frame-ancestors 'self'; object-src 'self' blob: https://*.supabase.co https://*.supabase.in",
      },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
    ]);
  });
});

describe("browserSecurityHeaders — preview (test/other NODE_ENV values)", () => {
  it("stays byte-identical to production for a non-development NODE_ENV", async () => {
    const prod = await headersFor("production");
    const other = await headersFor("test");
    expect(other).toEqual(prod);
  });
});

describe("browserSecurityHeaders — development (studio-live)", () => {
  it("adds the studio's exact origins to frame-ancestors and drops X-Frame-Options", async () => {
    const headers = await headersFor("development");
    const csp = headers.find((h) => h.key === "Content-Security-Policy");
    expect(csp?.value).toBe(
      "base-uri 'self'; frame-ancestors 'self' http://localhost:8960 http://127.0.0.1:8960 http://127.0.0.1:4387; " +
        "object-src 'self' blob: https://*.supabase.co https://*.supabase.in",
    );
    expect(headers.some((h) => h.key === "X-Frame-Options")).toBe(false);
  });

  it("keeps every other header identical to production", async () => {
    const prod = await headersFor("production");
    const dev = await headersFor("development");
    const withoutFrameHeaders = (list: typeof prod) =>
      list.filter((h) => h.key !== "Content-Security-Policy" && h.key !== "X-Frame-Options");
    expect(withoutFrameHeaders(dev)).toEqual(withoutFrameHeaders(prod));
  });
});
