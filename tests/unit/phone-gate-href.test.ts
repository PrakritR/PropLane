import { describe, expect, it } from "vitest";
import { phoneGateHref } from "@/lib/auth/phone-gate-href";

/**
 * The phone-required gate used to send everyone to a bare /auth/verify-phone, so "Request to book", "Apply" and
 * "Book a tour" lost the portal step they were heading to. It now carries the requested page, validated.
 */
describe("phoneGateHref", () => {
  it("carries the stay request the visitor was heading to", () => {
    const requested = "/resident/stays/request?listing=house-1&room=r1&checkIn=2026-11-09&checkOut=2026-11-12&guests=2";
    expect(phoneGateHref(requested)).toBe(`/auth/verify-phone?next=${encodeURIComponent(requested)}`);
  });

  it("carries apply and tour links", () => {
    expect(phoneGateHref("/resident/applications/apply?propertyId=p1")).toContain("next=%2Fresident%2Fapplications%2Fapply");
    expect(phoneGateHref("/resident/tour/schedule?propertyId=p1")).toContain("next=%2Fresident%2Ftour%2Fschedule");
  });

  it("falls back to the bare screen when there is nothing to carry", () => {
    expect(phoneGateHref(null)).toBe("/auth/verify-phone");
    expect(phoneGateHref("")).toBe("/auth/verify-phone");
  });

  it("never carries an off-site or malformed destination (no open redirect)", () => {
    for (const bad of ["//evil.example.com", "/\\evil.example.com", "https://evil.example.com/x", "evil.example.com", "/\t/evil.example.com", "/%2F%2Fevil.example.com", "/x\\y"]) {
      expect(phoneGateHref(bad), bad).toBe("/auth/verify-phone");
    }
  });

  it("never loops the gate onto an auth screen or an API route", () => {
    expect(phoneGateHref("/auth/verify-phone?next=/resident")).toBe("/auth/verify-phone");
    expect(phoneGateHref("/auth/continue")).toBe("/auth/verify-phone");
    expect(phoneGateHref("/api/auth/phone")).toBe("/auth/verify-phone");
  });
});
