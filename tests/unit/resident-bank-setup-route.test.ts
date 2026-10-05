import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "resident-1", email: "resident@example.test" } as { id: string; email: string } | null,
  residentRole: true,
  customerId: "cus_resident",
  setup: { id: "seti_resident", customer: "cus_resident", status: "requires_action",
    client_secret: "seti_secret", payment_method_types: ["us_bank_account"],
    next_action: { type: "verify_with_microdeposits" },
    metadata: { resident_user_id: "resident-1", resident_payment_flow: "saved_bank" } } as Record<string, unknown>,
  list: vi.fn(), retrieve: vi.fn(), verify: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user } }) },
}) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({
  from: () => { const query = { select: () => query, eq: () => query,
    maybeSingle: async () => ({ data: { role: "resident", stripe_customer_id: state.customerId }, error: null }) };
  return query; },
}) }));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => state.residentRole }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  TestWorkspaceProviderDisabledError: class TestWorkspaceProviderDisabledError extends Error {},
  assertTestWorkspaceProviderEffectAllowed: async () => {},
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ setupIntents: {
  list: (...args: unknown[]) => state.list(...args),
  retrieve: (...args: unknown[]) => state.retrieve(...args),
  verifyMicrodeposits: (...args: unknown[]) => state.verify(...args),
} }) }));

import { GET, POST } from "@/app/api/stripe/resident-bank-setup/route";

const listRequest = () => new Request("http://localhost/api/stripe/resident-bank-setup");
const detailRequest = () => new Request("http://localhost/api/stripe/resident-bank-setup?setup_intent_id=seti_resident");
const postRequest = () => new Request("http://localhost/api/stripe/resident-bank-setup", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ setupIntentId: "seti_resident", descriptorCode: "SM1234" }),
});

describe("resident saved bank verification resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: "resident-1", email: "resident@example.test" };
    state.residentRole = true;
    state.customerId = "cus_resident";
    state.setup = { id: "seti_resident", customer: "cus_resident", status: "requires_action",
      client_secret: "seti_secret", payment_method_types: ["us_bank_account"],
      next_action: { type: "verify_with_microdeposits" },
      metadata: { resident_user_id: "resident-1", resident_payment_flow: "saved_bank" } };
    state.list.mockResolvedValue({ data: [state.setup], has_more: false });
    state.retrieve.mockResolvedValue(state.setup);
    state.verify.mockResolvedValue({ ...state.setup, status: "succeeded" });
  });

  it("recovers the pending SetupIntent by exact customer and resident metadata after reload", async () => {
    const response = await GET(listRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bankStatus: "verification",
      setupIntentId: "seti_resident", clientSecret: "seti_secret" });
    expect(state.list).toHaveBeenCalledWith({ customer: "cus_resident", limit: 100 });
  });

  it("does not borrow a different customer's pending SetupIntent", async () => {
    state.setup.customer = "cus_other";
    const response = await GET(listRequest());
    expect(await response.json()).toEqual({ bankStatus: "none" });
  });

  it("fails closed when the first page is incomplete and no exact pending setup appears", async () => {
    state.list.mockResolvedValue({ data: [], has_more: true });
    const response = await GET(listRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "Bank setup history needs review." });
  });

  it("refuses nonresident setup verification before provider work", async () => {
    state.residentRole = false;
    const response = await POST(postRequest());
    expect(response.status).toBe(403);
    expect(state.verify).not.toHaveBeenCalled();
  });

  it("refuses a reused actor or different customer before provider verification", async () => {
    state.setup.customer = "cus_other";
    const response = await POST(postRequest());
    expect(response.status).toBe(403);
    expect(state.verify).not.toHaveBeenCalled();
  });

  it("verifies only the exact owned SetupIntent", async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    expect(state.verify).toHaveBeenCalledWith("seti_resident", { descriptor_code: "SM1234" });
    expect(await response.json()).toMatchObject({ bankStatus: "paid" });
    const detail = await GET(detailRequest());
    expect(await detail.json()).toMatchObject({ clientSecret: "seti_secret" });
  });
});
