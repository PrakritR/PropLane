import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "resident-1", email: "resident@example.test" } as { id: string; email: string } | null,
  residentRole: true,
  testWorkspace: false,
  intent: { id: "pi_manual", status: "requires_action",
    next_action: { type: "verify_with_microdeposits" } } as Record<string, unknown>,
  load: vi.fn(), verify: vi.fn(), reconcile: vi.fn(), retrieve: vi.fn(), create: vi.fn(), credit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user } }) },
}) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({
  from: () => { const query = { select: () => query, eq: () => query,
    maybeSingle: async () => ({ data: { role: "resident" }, error: null }) }; return query; },
}) }));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => state.residentRole }));
vi.mock("@/lib/test-workspaces/effects.server", () => {
  class TestWorkspaceProviderDisabledError extends Error {}
  return {
    TestWorkspaceProviderDisabledError,
    assertTestWorkspaceProviderEffectAllowed: async () => {
      if (state.testWorkspace) throw new TestWorkspaceProviderDisabledError("test workspace");
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ paymentIntents: {
  retrieve: async (...args: unknown[]) => { state.retrieve(...args); return state.intent; },
  create: (...args: unknown[]) => state.create(...args),
  verifyMicrodeposits: (...args: unknown[]) => state.verify(...args),
} }) }));
vi.mock("@/lib/resident-checkout-claim.server", () => ({
  loadResidentManualAchAttemptForPaymentIntent: (...args: unknown[]) => state.load(...args),
}));
vi.mock("@/lib/household-captured-source.server", () => ({
  creditVerifiedHouseholdManualSource: (...args: unknown[]) => state.credit(...args),
}));
vi.mock("@/lib/stripe-household-charge", () => ({
  reconcileResidentManualAchPaymentIntent: (...args: unknown[]) => state.reconcile(...args),
}));

import { GET, POST } from "@/app/api/stripe/resident-ach-payment/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/stripe/resident-ach-payment", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("resident bank payment actor and provider gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: "resident-1", email: "resident@example.test" };
    state.residentRole = true;
    state.testWorkspace = false;
    state.intent = { id: "pi_manual", status: "requires_action",
      next_action: { type: "verify_with_microdeposits" } };
    state.load.mockResolvedValue({ id: "attempt-1", charge_ids: ["hc_1"],
      subtotal_cents: 120500, payer_total_cents: 121000 });
    state.reconcile.mockResolvedValue({ ok: true, paid: false, processing: true, chargeId: "hc_1" });
    state.verify.mockResolvedValue(state.intent);
  });

  it("refuses a nonresident before reading or verifying the PaymentIntent", async () => {
    state.residentRole = false;
    const response = await POST(request({ paymentIntentId: "pi_manual", descriptorCode: "SM1234" }));
    expect(response.status).toBe(403);
    expect(state.retrieve).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.verify).not.toHaveBeenCalled();
  });

  it("applies the test-workspace gate before any Stripe call, then the original-actor claim before verification", async () => {
    state.testWorkspace = true;
    const refused = await POST(request({ paymentIntentId: "pi_manual", descriptorCode: "SM1234" }));
    expect(refused.status).toBe(403);
    expect(state.retrieve).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.verify).not.toHaveBeenCalled();

    state.testWorkspace = false;
    state.load.mockRejectedValueOnce(new Error("Resident attempt does not belong to this actor."));
    const notYours = await POST(request({ paymentIntentId: "pi_manual", descriptorCode: "SM1234" }));
    expect(notYours.status).toBe(403);
    expect(state.load).toHaveBeenCalledWith(expect.anything(), state.intent, "resident-1");
    expect(state.verify).not.toHaveBeenCalled();
  });

  it("reopens the exact original PaymentIntent through GET without creating or verifying anything", async () => {
    const response = await GET(new Request("http://localhost/api/stripe/resident-ach-payment?payment_intent_id=pi_manual"));
    expect(response.status).toBe(200);
    expect(state.retrieve).toHaveBeenCalledTimes(1);
    expect(state.retrieve).toHaveBeenCalledWith("pi_manual");
    expect(state.create).not.toHaveBeenCalled();
    expect(state.verify).not.toHaveBeenCalled();
    expect(state.load).toHaveBeenCalledWith(expect.anything(), state.intent, "resident-1");
    expect(await response.json()).toMatchObject({ paymentIntentId: "pi_manual", chargeIds: ["hc_1"],
      bankStatus: "verification", subtotalCents: 120500, totalCents: 121000 });
  });

  it("never credits a source from GET until the exact PaymentIntent is paid", async () => {
    await GET(new Request("http://localhost/api/stripe/resident-ach-payment?payment_intent_id=pi_manual"));
    expect(state.credit).not.toHaveBeenCalled();
  });

  it("verifies an exact resident attempt and returns only its processing state", async () => {
    const response = await POST(request({ paymentIntentId: "pi_manual", amounts: [32, 45] }));
    expect(response.status).toBe(200);
    expect(state.verify).toHaveBeenCalledWith("pi_manual", { amounts: [32, 45] });
    expect(await response.json()).toMatchObject({ paid: false, processing: true, bankStatus: "verification",
      subtotalCents: 120500, processingFeeCents: 500, axisFeeCents: 0, totalCents: 121000 });
  });

  it("does not expose an attempted payment through GET to a nonresident", async () => {
    state.residentRole = false;
    const response = await GET(new Request("http://localhost/api/stripe/resident-ach-payment?payment_intent_id=pi_manual"));
    expect(response.status).toBe(403);
    expect(state.load).not.toHaveBeenCalled();
  });
});
