import { describe, expect, it } from "vitest";
import {
  failClosedOAuthContinuePath,
  isBareDashboardPath,
  isUnsafeRedirectPath,
  normalizePostAuthPath,
} from "@/lib/auth/normalize-post-auth-path";

describe("isUnsafeRedirectPath", () => {
  it("flags protocol-relative and off-site scheme paths", () => {
    expect(isUnsafeRedirectPath("//evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("/\\evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("/https://evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("/http://evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("%2F%2Fevil.com")).toBe(true);
  });

  it("flags tab/newline/CR-obfuscated protocol-relative paths (never literally start with '//')", () => {
    // A browser's URL parser strips ASCII tab/newline/CR anywhere in the
    // string before resolving, so these all resolve to a DIFFERENT origin
    // even though none of them literally starts with "//" or "/\\" — a naive
    // prefix check misses every one of these.
    expect(isUnsafeRedirectPath("/\t/evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("/\n/evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("/\r/evil.com")).toBe(true);
    expect(isUnsafeRedirectPath("/\t\\evil.com")).toBe(true);
  });

  it("allows normal same-origin paths", () => {
    expect(isUnsafeRedirectPath("/portal/dashboard")).toBe(false);
    expect(isUnsafeRedirectPath("/auth/continue")).toBe(false);
    expect(isUnsafeRedirectPath("/resident/dashboard")).toBe(false);
    expect(isUnsafeRedirectPath("/rent/apply?propertyId=mgr-qa-madison")).toBe(false);
  });
});

describe("normalizePostAuthPath", () => {
  it("maps bare /dashboard to role dashboard or continue", () => {
    expect(isBareDashboardPath("/dashboard")).toBe(true);
    expect(normalizePostAuthPath("/dashboard")).toBe("/auth/continue");
    expect(normalizePostAuthPath("/dashboard", "resident")).toBe("/resident");
    expect(normalizePostAuthPath("/dashboard", "manager")).toBe("/portal/dashboard");
  });

  it("keeps valid portal paths", () => {
    expect(normalizePostAuthPath("/portal/dashboard")).toBe("/portal/dashboard");
    expect(normalizePostAuthPath("/resident/dashboard")).toBe("/resident/dashboard");
  });

  it("keeps a co-manager invite return path for any role", () => {
    const next = "/auth/co-manager-invite?token=abc";
    expect(isUnsafeRedirectPath(next)).toBe(false);
    expect(normalizePostAuthPath(next, "manager")).toBe(next);
    expect(normalizePostAuthPath(next, "resident")).toBe(next);
  });

  it("rejects open redirects", () => {
    expect(normalizePostAuthPath("//evil.com")).toBe("/auth/continue");
    expect(normalizePostAuthPath("//evil.com", "manager")).toBe("/portal/dashboard");
    expect(normalizePostAuthPath("/https://evil.com")).toBe("/auth/continue");
  });
});

describe("failClosedOAuthContinuePath", () => {
  it("routes through /auth/continue with a safe next param", () => {
    expect(failClosedOAuthContinuePath("/portal/dashboard")).toBe(
      "/auth/continue?next=%2Fportal%2Fdashboard",
    );
    expect(failClosedOAuthContinuePath("/auth/continue")).toBe("/auth/continue");
    expect(failClosedOAuthContinuePath("//evil.com")).toBe("/auth/continue");
  });
});
