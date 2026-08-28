/**
 * The staff control over who pays a manager's processing fees.
 *
 * This route is the authorization boundary for the one setting that can move a cost onto
 * PropLane itself. `saveAdminServiceFeeOverride` does no authorization of its own — matching every
 * other service-role writer in this codebase — so if this route lets a non-admin through, nothing
 * downstream catches it.
 *
 * The other thing worth pinning is that `null` is a real value here. Clearing the override returns
 * a manager to the plan-and-choice rule; pinning "resident" fixes the answer whatever they later
 * choose. A route that collapsed the two would quietly freeze every manager staff had touched.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const isAdminUser = vi.fn();
const getUser = vi.fn();
const saveAdminServiceFeeOverride = vi.fn();
const loadManagerManualPaymentSettings = vi.fn();
const getManagerPurchaseSku = vi.fn();

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({
  saveAdminServiceFeeOverride: (...a: unknown[]) => saveAdminServiceFeeOverride(...a),
  loadManagerManualPaymentSettings: (...a: unknown[]) => loadManagerManualPaymentSettings(...a),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: (...a: unknown[]) => getManagerPurchaseSku(...a),
}));

const { GET, POST } = await import("@/app/api/admin/manager-service-fee/route");

const post = (body: unknown) =>
  POST(new Request("https://prop-lane.space/api/admin/manager-service-fee", {
    method: "POST",
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
  getManagerPurchaseSku.mockResolvedValue({ tier: "pro" });
  loadManagerManualPaymentSettings.mockResolvedValue({
    serviceFeePayer: "resident",
    adminServiceFeeOverride: null,
  });
  saveAdminServiceFeeOverride.mockImplementation(async (_db, _id, override) => ({
    serviceFeePayer: "resident",
    adminServiceFeeOverride: override,
  }));
});

describe("who may call it", () => {
  it("refuses a signed-out caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await post({ managerUserId: "mgr-1", adminOverride: "proplane" })).status).toBe(401);
    expect(saveAdminServiceFeeOverride).not.toHaveBeenCalled();
  });

  it("refuses a signed-in NON-admin", async () => {
    // The manager whose fees these are must not be able to call it either.
    isAdminUser.mockResolvedValue(false);
    getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
    expect((await post({ managerUserId: "mgr-1", adminOverride: "proplane" })).status).toBe(401);
    expect(saveAdminServiceFeeOverride).not.toHaveBeenCalled();
  });

  it("refuses a read to a non-admin too", async () => {
    isAdminUser.mockResolvedValue(false);
    const res = await GET(new Request("https://x/api/admin/manager-service-fee?managerUserId=mgr-1"));
    expect(res.status).toBe(401);
  });
});

describe("what it accepts", () => {
  it("sets an override", async () => {
    const res = await post({ managerUserId: "mgr-1", adminOverride: "proplane" });
    expect(res.status).toBe(200);
    expect(saveAdminServiceFeeOverride).toHaveBeenCalledWith(expect.anything(), "mgr-1", "proplane");
    expect((await res.json()).effectivePayer).toBe("proplane");
  });

  it("clears an override with an explicit null", async () => {
    // Distinct from pinning "resident" — this hands the manager back to the plan rule.
    const res = await post({ managerUserId: "mgr-1", adminOverride: null });
    expect(res.status).toBe(200);
    expect(saveAdminServiceFeeOverride).toHaveBeenCalledWith(expect.anything(), "mgr-1", null);
  });

  it("rejects an unrecognised value instead of coercing it", async () => {
    // Reading it as "resident" would report success while doing something else.
    const res = await post({ managerUserId: "mgr-1", adminOverride: "free" });
    expect(res.status).toBe(400);
    expect(saveAdminServiceFeeOverride).not.toHaveBeenCalled();
  });

  it("requires a manager id", async () => {
    expect((await post({ adminOverride: "manager" })).status).toBe(400);
    expect((await post({ managerUserId: "   ", adminOverride: "manager" })).status).toBe(400);
  });
});

describe("what it reports back", () => {
  it("reports the NET payer, not just what was stored", async () => {
    // A free-tier manager who chose to absorb fees still cannot, so the screen must show
    // "resident" rather than echoing the stored choice and disagreeing with the actual charge.
    getManagerPurchaseSku.mockResolvedValue({ tier: "free" });
    loadManagerManualPaymentSettings.mockResolvedValue({
      serviceFeePayer: "manager",
      adminServiceFeeOverride: null,
    });
    const res = await GET(new Request("https://x/api/admin/manager-service-fee?managerUserId=mgr-1"));
    const body = await res.json();
    expect(body.managerChoice).toBe("manager");
    expect(body.effectivePayer).toBe("resident");
  });

  it("shows staff overriding the plan floor", async () => {
    getManagerPurchaseSku.mockResolvedValue({ tier: "free" });
    loadManagerManualPaymentSettings.mockResolvedValue({
      serviceFeePayer: "resident",
      adminServiceFeeOverride: "proplane",
    });
    const res = await GET(new Request("https://x/api/admin/manager-service-fee?managerUserId=mgr-1"));
    expect((await res.json()).effectivePayer).toBe("proplane");
  });

  it("does not leak an internal error message", async () => {
    saveAdminServiceFeeOverride.mockRejectedValue(new Error("supabase: service role key revoked"));
    const res = await post({ managerUserId: "mgr-1", adminOverride: "manager" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("service role");
  });
});
