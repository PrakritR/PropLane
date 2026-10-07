// VD04: POST /api/vendor/work-identity/candidates — the read-only area-code
// search backing "pick one of 3" in the vendor work-number claim flow. Never
// touches Twilio directly; the server module it delegates to is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

const mocks = vi.hoisted(() => ({
  resolveVendorPortalUserId: vi.fn(),
  searchVendorWorkNumberCandidates: vi.fn(),
  loadVendorVerifiedPhone: vi.fn(),
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: mocks.resolveVendorPortalUserId,
}));
vi.mock("@/lib/vendor-work-identity.server", () => ({
  searchVendorWorkNumberCandidates: mocks.searchVendorWorkNumberCandidates,
  loadVendorVerifiedPhone: mocks.loadVendorVerifiedPhone,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

import { POST } from "@/app/api/vendor/work-identity/candidates/route";

describe("POST /api/vendor/work-identity/candidates", () => {
  beforeEach(() => {
    mocks.resolveVendorPortalUserId.mockReset();
    mocks.searchVendorWorkNumberCandidates.mockReset();
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: "vendor-1" });
    mocks.loadVendorVerifiedPhone.mockResolvedValue({ verified: true, phone: "+12065550142" });
  });

  it("403s a vendor whose phone is not verified before any search", async () => {
    mocks.loadVendorVerifiedPhone.mockResolvedValue({ verified: false, phone: null });
    const res = await POST(jsonRequest("http://test/api/vendor/work-identity/candidates", { method: "POST", body: { areaCode: "206" } }));
    const { status, data } = await parseJsonResponse<{ ok: boolean; code: string }>(res);
    expect(status).toBe(403);
    expect(data.code).toBe("phone_unverified");
    expect(mocks.searchVendorWorkNumberCandidates).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller before touching the search", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: false, status: 401 });
    const res = await POST(jsonRequest("http://test/api/vendor/work-identity/candidates", { method: "POST", body: { areaCode: "206" } }));
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(401);
    expect(mocks.searchVendorWorkNumberCandidates).not.toHaveBeenCalled();
  });

  it("rejects a malformed area code without calling the provider search", async () => {
    const res = await POST(jsonRequest("http://test/api/vendor/work-identity/candidates", { method: "POST", body: { areaCode: "1" } }));
    const { status, data } = await parseJsonResponse<{ ok: boolean; error: string }>(res);
    expect(status).toBe(400);
    expect(data.ok).toBe(false);
    expect(mocks.searchVendorWorkNumberCandidates).not.toHaveBeenCalled();
  });

  it("returns up to 3 candidates for a valid area code, each carrying a claim token bound to this vendor", async () => {
    mocks.searchVendorWorkNumberCandidates.mockResolvedValue(["+12065550101", "+12065550102", "+12065550103"]);
    const res = await POST(jsonRequest("http://test/api/vendor/work-identity/candidates", { method: "POST", body: { areaCode: "206" } }));
    const { status, data } = await parseJsonResponse<{ ok: boolean; candidates: { phoneNumber: string; claimToken: string }[] }>(res);
    expect(status).toBe(200);
    expect(data.candidates.map((c) => c.phoneNumber)).toEqual(["+12065550101", "+12065550102", "+12065550103"]);
    expect(mocks.searchVendorWorkNumberCandidates).toHaveBeenCalledWith("206");
    for (const candidate of data.candidates) {
      expect(typeof candidate.claimToken).toBe("string");
      expect(candidate.claimToken.split(".").length).toBe(2);
    }
    // No two candidates share a token, and each verifies to its own number/vendor.
    const { verifyVendorWorkNumberClaim } = await import("@/lib/vendor-work-number-claim-token.server");
    for (const candidate of data.candidates) {
      const payload = verifyVendorWorkNumberClaim(candidate.claimToken);
      expect(payload?.vendorUserId).toBe("vendor-1");
      expect(payload?.phoneNumber).toBe(candidate.phoneNumber);
    }
  });

  it("answers 503 rather than leaking a raw provider error when the search throws", async () => {
    mocks.searchVendorWorkNumberCandidates.mockRejectedValue(new Error("twilio down"));
    const res = await POST(jsonRequest("http://test/api/vendor/work-identity/candidates", { method: "POST", body: { areaCode: "206" } }));
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(503);
  });
});
