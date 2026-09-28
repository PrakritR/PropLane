// Security review fix on VD04: a claim token binds a vendor to an EXACT
// number so /api/vendor/work-identity can no longer be made to purchase an
// arbitrary Twilio number (toll-free, premium-rate, foreign) just by naming
// it in the request body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isUsLocalSmsNumber,
  signVendorWorkNumberClaim,
  verifyVendorWorkNumberClaim,
} from "@/lib/vendor-work-number-claim-token.server";

describe("signVendorWorkNumberClaim / verifyVendorWorkNumberClaim", () => {
  beforeEach(() => vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key"));
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips a valid token for the exact vendor and number", () => {
    const token = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" });
    const payload = verifyVendorWorkNumberClaim(token);
    expect(payload?.vendorUserId).toBe("vendor-1");
    expect(payload?.phoneNumber).toBe("+12065550101");
  });

  it("rejects a forged token (tampered signature)", () => {
    const token = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" });
    const [encoded] = token.split(".");
    const forged = `${encoded}.${"a".repeat(43)}`;
    expect(verifyVendorWorkNumberClaim(forged)).toBeNull();
  });

  it("rejects a token whose payload was edited without re-signing (phone number swapped)", () => {
    const token = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" });
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ vendorUserId: "vendor-1", phoneNumber: "+18005551234", expiresAt: Date.now() + 60_000 }),
      "utf8",
    ).toString("base64url");
    expect(verifyVendorWorkNumberClaim(`${tamperedPayload}.${signature}`)).toBeNull();
  });

  it("rejects a token signed for a different vendor when checked against the caller's id", () => {
    const token = signVendorWorkNumberClaim({ vendorUserId: "vendor-attacker", phoneNumber: "+12065550101" });
    const payload = verifyVendorWorkNumberClaim(token);
    expect(payload).not.toBeNull();
    expect(payload!.vendorUserId).not.toBe("vendor-victim");
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);
      const token = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" });
      vi.setSystemTime(new Date(now.getTime() + 16 * 60_000));
      expect(verifyVendorWorkNumberClaim(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects garbage input", () => {
    expect(verifyVendorWorkNumberClaim("not-a-token")).toBeNull();
    expect(verifyVendorWorkNumberClaim("")).toBeNull();
    expect(verifyVendorWorkNumberClaim("a.b.c")).toBeNull();
  });
});

describe("isUsLocalSmsNumber", () => {
  it("accepts a plausible US local number", () => {
    expect(isUsLocalSmsNumber("+12065550101")).toBe(true);
  });

  it("rejects every US toll-free NPA", () => {
    for (const npa of ["800", "833", "844", "855", "866", "877", "888"]) {
      expect(isUsLocalSmsNumber(`+1${npa}5551234`)).toBe(false);
    }
  });

  it("rejects a non-US / non-NANP number", () => {
    expect(isUsLocalSmsNumber("+442071234567")).toBe(false);
  });

  it("rejects a malformed or too-short number", () => {
    expect(isUsLocalSmsNumber("+1206555")).toBe(false);
    expect(isUsLocalSmsNumber("not-a-number")).toBe(false);
  });
});
