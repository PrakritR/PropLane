import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "resident-1", email: "resident@example.test" } as { id: string; email: string } | null,
  attempt: null as Record<string, unknown> | null,
  session: null as Record<string, unknown> | null,
  paidResult: { ok: true, alreadyPaid: false } as { ok: boolean; alreadyPaid?: boolean },
  processingResult: { ok: true, marked: 1 } as { ok: boolean; marked: number },
  paidCalls: vi.fn(), processingCalls: vi.fn(), bindCalls: vi.fn(),
  residentRole: true,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const query = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: state.attempt, error: null }) };
      return query;
    },
    rpc: state.bindCalls,
  }),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve: async () => state.session } } }),
}));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => state.residentRole }));
vi.mock("@/lib/stripe-household-charge", () => ({
  isHouseholdChargeCheckoutSession: (session: { metadata?: { purpose?: string } }) =>
    session.metadata?.purpose === "household_charge",
  householdChargeCheckoutProcessing: (session: { status?: string; payment_status?: string }) =>
    session.status === "complete" && session.payment_status === "unpaid",
  markHouseholdChargePaidFromStripeSession: async () => { state.paidCalls(); return state.paidResult; },
  markHouseholdChargeProcessingFromStripeSession: async () => { state.processingCalls(); return state.processingResult; },
}));

import { GET } from "@/app/api/stripe/household-charge-verify/route";

function fixture() {
  const metadata = { purpose: "household_charge", source_arbitration_v: "1",
    resident_attempt_token: "attempt-token", charge_id: "hc_a", charge_ids: "hc_a",
    manager_user_id: "manager-1", resident_email: "resident@example.test",
    payment_method: "card", subtotal_cents: "1000", processing_fee_cents: "0",
    manager_payout_cents: "1000", fee_payer: "proplane", platform_hold: "1",
    hold_amount_cents: "1000" };
  state.attempt = {
    id: "attempt-1", attempt_token: "attempt-token", resident_user_id: "resident-1",
    resident_email: "resident@example.test", manager_user_id: "manager-1",
    charge_ids: ["hc_a"], charge_cents: [1000], subtotal_cents: 1000,
    payer_total_cents: 1000, recipient_net_cents: 1000, payment_method: "card",
    currency: "usd", stripe_session_id: "cs_paid", status: "pending",
    provider_params: { residentEmail: "resident@example.test", mode: "embedded", paymentMethod: "card",
      lineItems: [{ amountCents: 1000, productName: "Rent" }], metadata,
      destinationAccountId: null, fundingModel: "connect_destination", forceExplicitCard: true,
      idempotencyKey: "resident-checkout:attempt-token", feePayer: "proplane",
      fixedFeeBreakdown: { serviceFeeCents: 0, residentAddedFeeCents: 0,
        applicationFeeCents: 0, totalCents: 1000, managerPayoutCents: 1000 } },
  };
  state.session = { id: "cs_paid", mode: "payment", status: "complete",
    payment_status: "paid", currency: "usd", amount_total: 1000,
    payment_intent: "pi_paid", metadata };
}

function verify() {
  return GET(new Request("http://localhost/api/stripe/household-charge-verify?session_id=cs_paid"));
}

describe("resident household checkout verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: "resident-1", email: "resident@example.test" };
    state.paidResult = { ok: true, alreadyPaid: false };
    state.processingResult = { ok: true, marked: 1 };
    state.residentRole = true;
    state.bindCalls.mockResolvedValue({ data: true, error: null });
    fixture();
  });

  it("returns paid only after the exact claim settlement succeeds", async () => {
    const response = await verify();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paid: true, chargeId: "hc_a", sessionId: "cs_paid" });
    expect(state.paidCalls).toHaveBeenCalledOnce();
  });

  it("refuses a user without resident role before provider verification", async () => {
    state.residentRole = false;
    const response = await verify();
    expect(response.status).toBe(403);
    expect(state.paidCalls).not.toHaveBeenCalled();
  });

  it("does not credit a session owned by a different auth user even with the same email", async () => {
    state.user = { id: "replacement-user", email: "resident@example.test" };
    const response = await verify();
    expect(response.status).toBe(403);
    expect(state.paidCalls).not.toHaveBeenCalled();
  });

  it("refuses wrong captured amount before settlement", async () => {
    state.session!.amount_total = 1200;
    const response = await verify();
    expect(response.status).toBe(409);
    expect(state.paidCalls).not.toHaveBeenCalled();
  });

  it("returns unpaid if a provider-paid session could not settle the charge", async () => {
    state.paidResult = { ok: false };
    const response = await verify();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ paid: false, processing: false });
  });

  it("never treats no_payment_required on a positive amount as a paid receipt", async () => {
    state.session!.payment_status = "no_payment_required";
    const response = await verify();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paid: false, processing: false });
    expect(state.paidCalls).not.toHaveBeenCalled();
  });

  it("persists an unpaid completed bank session as processing", async () => {
    state.session!.payment_status = "unpaid";
    const response = await verify();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ paid: false, processing: true });
    expect(state.processingCalls).toHaveBeenCalledOnce();
  });

  it("holds unclaimed historical sessions for review", async () => {
    delete state.session!.metadata!.source_arbitration_v;
    const response = await verify();
    expect(response.status).toBe(409);
    expect(state.paidCalls).not.toHaveBeenCalled();
  });
});
