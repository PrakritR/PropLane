import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: "manager-1",
  row: { manager_user_id: "manager-1", property_id: "house-1",
    row_data: { id: "charge-1", residentUserId: "resident-1",
      residentEmail: "resident@example.test" } },
  checkout: vi.fn(),
  allowed: true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: state.user } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const query = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: state.row, error: null }) };
      return query;
    },
  }),
}));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  resolveManagerWorkspaceRowScope: async () => ({}),
  rowInWorkspaceScope: () => state.allowed,
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: async () => state.allowed,
}));
vi.mock("@/lib/stripe-household-charge-checkout.server", () => ({
  createHouseholdChargeCheckout: (...args: unknown[]) => state.checkout(...args),
}));
vi.mock("@/lib/app-url", () => ({ resolveAppOrigin: () => "https://test.example" }));

import { POST } from "@/app/api/portal/take-payment/route";

function request(paymentMethod: string) {
  return new Request("https://test.example/api/portal/take-payment", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chargeId: "charge-1", paymentMethod }),
  });
}

describe("manager-assisted payment method authority", () => {
  beforeEach(() => {
    state.user = "manager-1";
    state.allowed = true;
    state.checkout.mockReset();
    state.checkout.mockResolvedValue({ ok: true, mode: "embedded", clientSecret: "cs_test" });
  });

  it("refuses ACH after exact charge scope without creating a resident mandate", async () => {
    const response = await POST(request("ach"));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "The resident must authorize bank payment in Payments." });
    expect(state.checkout).not.toHaveBeenCalled();
  });

  it("keeps authorized manager card collection on the existing exact charge", async () => {
    const response = await POST(request("card"));
    expect(response.status).toBe(200);
    expect(state.checkout).toHaveBeenCalledOnce();
    expect(state.checkout.mock.calls[0][1]).toMatchObject({
      userId: "resident-1", userEmail: "resident@example.test",
      chargeIds: ["charge-1"], expectedManagerUserId: "manager-1",
      paymentMethod: "card", mode: "embedded",
    });
  });

  it("does not disclose an out-of-scope charge to a co-manager asking for ACH", async () => {
    state.user = "other-manager";
    state.allowed = false;
    const response = await POST(request("ach"));
    expect(response.status).toBe(404);
    expect(state.checkout).not.toHaveBeenCalled();
  });
});
