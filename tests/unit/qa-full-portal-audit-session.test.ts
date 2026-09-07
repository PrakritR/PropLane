import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PRP-364: the full-portal QA audit must not re-authenticate on every bounce —
 * that trips Supabase rate limits and manufactures false page findings.
 */
describe("qa-full-portal-audit session reuse (PRP-364)", () => {
  const src = readFileSync(
    join(process.cwd(), "scripts/qa-full-portal-audit.mjs"),
    "utf8",
  );

  it("signs in once per portal and never calls signIn from auditPath", () => {
    const auditPathStart = src.indexOf("async function auditPath(");
    const auditPathEnd = src.indexOf("async function auditManagerInteractions(");
    expect(auditPathStart).toBeGreaterThan(-1);
    expect(auditPathEnd).toBeGreaterThan(auditPathStart);
    const auditPathBody = src.slice(auditPathStart, auditPathEnd);
    expect(auditPathBody).not.toMatch(/await\s+signIn\s*\(/);
    expect(src).toMatch(/One sign-in per portal role/);
  });

  it("aborts the run on auth 429 and session-lost bounce", () => {
    expect(src).toContain("class AuthRateLimitedError");
    expect(src).toContain("class SessionLostError");
    expect(src).toContain("watchAuthRateLimit");
    expect(src).toMatch(/throw new SessionLostError/);
    expect(src).toMatch(/throw new AuthRateLimitedError/);
  });

  it("does not file bare Failed to fetch / auth 429 as page console defects", () => {
    expect(src).toContain("TypeError:\\s*Failed to fetch");
    expect(src).toContain("\\b429\\b");
  });
});
