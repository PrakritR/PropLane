// Security review fix on VD04: POST /api/vendor/work-identity must never
// purchase a number just because a phoneNumber string arrived in the body.
// Every SMS claim needs a signed claimToken (minted only by
// /api/vendor/work-identity/candidates) that matches the caller, the exact
// number, hasn't expired, and names a real US local number.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

const mocks = vi.hoisted(() => ({
  resolveVendorPortalUserId: vi.fn(),
  setupVendorWorkIdentity: vi.fn(),
  getVendorWorkIdentity: vi.fn(),
  loadVendorVerifiedPhone: vi.fn(),
  setVendorForwardToPhone: vi.fn(),
  createSupabaseServiceRoleClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: mocks.resolveVendorPortalUserId,
}));
vi.mock("@/lib/vendor-work-identity.server", () => ({
  setupVendorWorkIdentity: mocks.setupVendorWorkIdentity,
  getVendorWorkIdentity: mocks.getVendorWorkIdentity,
  loadVendorVerifiedPhone: mocks.loadVendorVerifiedPhone,
  setVendorForwardToPhone: mocks.setVendorForwardToPhone,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.createSupabaseServiceRoleClient,
}));

import { POST } from "@/app/api/vendor/work-identity/route";
import { signVendorWorkNumberClaim } from "@/lib/vendor-work-number-claim-token.server";

const IDEMPOTENCY_KEY = "11111111-1111-1111-1111-111111111111";

function claimBody(overrides: Record<string, unknown> = {}) {
  return { channel: "sms", idempotencyKey: IDEMPOTENCY_KEY, ...overrides };
}

describe("POST /api/vendor/work-identity — SMS claim requires a valid, matching, non-expired, US-local claim token", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    mocks.resolveVendorPortalUserId.mockReset();
    mocks.setupVendorWorkIdentity.mockReset();
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-1" });
    mocks.setupVendorWorkIdentity.mockResolvedValue({ ok: true, sms: { value: "+12065550101" } });
    mocks.loadVendorVerifiedPhone.mockResolvedValue({ verified: true, phone: "+12065550142" });
  });

  it("refuses a claim with no claimToken at all", async () => {
    const res = await POST(jsonRequest("http://test/api/vendor/work-identity", { method: "POST", body: claimBody({ phoneNumber: "+12065550101" }) }));
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(400);
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("refuses a forged claimToken", async () => {
    const real = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" });
    const forged = `${real.split(".")[0]}.${"a".repeat(43)}`;
    const res = await POST(
      jsonRequest("http://test/api/vendor/work-identity", { method: "POST", body: claimBody({ phoneNumber: "+12065550101", claimToken: forged }) }),
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(400);
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("refuses a claimToken minted for a different vendor", async () => {
    const tokenForSomeoneElse = signVendorWorkNumberClaim({ vendorUserId: "vendor-attacker", phoneNumber: "+12065550101" });
    const res = await POST(
      jsonRequest("http://test/api/vendor/work-identity", {
        method: "POST",
        body: claimBody({ phoneNumber: "+12065550101", claimToken: tokenForSomeoneElse }),
      }),
    );
    const { status, data } = await parseJsonResponse<{ error: string }>(res);
    expect(status).toBe(400);
    expect(data.error).toMatch(/does not belong to your account/i);
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("refuses an expired claimToken", async () => {
    vi.useFakeTimers();
    let token: string;
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      token = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" });
      vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
    } finally {
      vi.useRealTimers();
    }
    const res = await POST(
      jsonRequest("http://test/api/vendor/work-identity", { method: "POST", body: claimBody({ phoneNumber: "+12065550101", claimToken: token! }) }),
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(400);
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("refuses a toll-free number even with an otherwise-valid token for it", async () => {
    const tollFreeToken = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+18005551234" });
    const res = await POST(
      jsonRequest("http://test/api/vendor/work-identity", { method: "POST", body: claimBody({ phoneNumber: "+18005551234", claimToken: tollFreeToken }) }),
    );
    const { status, data } = await parseJsonResponse<{ error: string }>(res);
    expect(status).toBe(400);
    expect(data.error).toMatch(/US local number/i);
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("refuses a phoneNumber that does not match the number the token was signed for", async () => {
    const token = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" });
    const res = await POST(
      jsonRequest("http://test/api/vendor/work-identity", { method: "POST", body: claimBody({ phoneNumber: "+12065550999", claimToken: token }) }),
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(400);
    expect(mocks.setupVendorWorkIdentity).not.toHaveBeenCalled();
  });

  it("a valid token for a real US local number calls setupVendorWorkIdentity with exactly that number", async () => {
    const token = signVendorWorkNumberClaim({ vendorUserId: "vendor-1", phoneNumber: "+12065550101" });
    const res = await POST(
      jsonRequest("http://test/api/vendor/work-identity", { method: "POST", body: claimBody({ phoneNumber: "+12065550101", claimToken: token }) }),
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(200);
    expect(mocks.setupVendorWorkIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.setupVendorWorkIdentity).toHaveBeenCalledWith(
      expect.anything(),
      "vendor-1",
      IDEMPOTENCY_KEY,
      "sms",
      undefined,
      "+12065550101",
    );
  });
});
