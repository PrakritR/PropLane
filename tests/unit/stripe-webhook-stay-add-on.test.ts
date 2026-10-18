/**
 * The Stripe webhook hands every PAID household charge to the stay add-on settlement (bookings-times-1018):
 * a paid card checkout and a cleared bank payment both settle it; a payment still clearing (`processing`)
 * never does; a settlement that throws answers 500 so Stripe redelivers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";

const state = vi.hoisted(() => ({ db: null as unknown, event: null as unknown, stripe: { webhooks: { constructEvent: () => state.event } } as unknown }));
const spies = vi.hoisted(() => ({
  settle: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  markPaid: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  markProcessing: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  reconcile: vi.fn(async (..._args: unknown[]) => ({ ok: true, paid: true, processing: false })),
  track: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => "sig" }) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => state.stripe }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: async () => ({ captured: false }) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: spies.track }));
vi.mock("@/lib/short-stay/stay-add-on-settlement.server", () => ({ settleStayAddOnsForCharges: spies.settle }));
vi.mock("@/lib/stripe-ledger-fees", () => ({ enrichLedgerFromCheckoutSession: vi.fn(async () => undefined) }));
vi.mock("@/lib/household-source-review.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/household-source-review.server")>()),
  creditOrFileHouseholdSourceReview: async (_db: unknown, _input: unknown, credit: () => Promise<unknown>) => credit(),
}));
vi.mock("@/lib/household-captured-source.server", () => ({
  creditVerifiedHouseholdCheckoutSource: vi.fn(async () => undefined),
  creditVerifiedHouseholdManualSource: vi.fn(async () => undefined),
  verifyExistingHistoricalHouseholdHold: vi.fn(async () => undefined),
}));
vi.mock("@/lib/stripe-household-charge", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe-household-charge")>()),
  markHouseholdChargePaidFromStripeSession: spies.markPaid,
  markHouseholdChargeProcessingFromStripeSession: spies.markProcessing,
  reconcileResidentManualAchPaymentIntent: spies.reconcile,
}));

import { POST as webhook } from "@/app/api/stripe/webhook/route";

const OWNER = "11111111-1111-4111-8111-111111111111";
const CHARGE = "hc_mgr_stay_axis_room_block_owner_1_stay_1_early_check_in";

function deliver(type: string, object: Record<string, unknown>) {
  state.event = { id: "evt_1", type, data: { object } };
  return webhook(new Request("http://localhost/api/stripe/webhook", { method: "POST", body: "{}" }));
}

const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_test_addon",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  payment_intent: "pi_test_addon",
  metadata: { purpose: "household_charge", charge_id: CHARGE, charge_ids: CHARGE, manager_user_id: OWNER, source_arbitration_v: "1" },
  ...over,
});

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  Object.values(spies).forEach((spy) => "mockClear" in spy && spy.mockClear());
  spies.settle.mockResolvedValue([]);
  state.db = createFakeDb({ portal_household_charge_records: [{ id: CHARGE, manager_user_id: OWNER, status: "pending", row_data: {} }] });
});

describe("a paid add-on charge reaches the settlement", () => {
  it("a paid card checkout settles the charges in its metadata, with the payment intent", async () => {
    const res = await deliver("checkout.session.completed", session());
    expect(res.status).toBe(200);
    expect(spies.markPaid).toHaveBeenCalledTimes(1);
    expect(spies.settle).toHaveBeenCalledTimes(1);
    expect(spies.settle.mock.calls[0]![1]).toMatchObject({ chargeIds: [CHARGE], paymentIntentId: "pi_test_addon" });
  });

  it("a bank payment still clearing (processing) never settles anything", async () => {
    const res = await deliver("checkout.session.completed", session({ payment_status: "unpaid", metadata: { ...session().metadata, manual_ach: "1", resident_payment_flow: "manual_ach" } }));
    expect(res.status).toBe(200);
    expect(spies.markProcessing).toHaveBeenCalledTimes(1);
    expect(spies.markPaid).not.toHaveBeenCalled();
    expect(spies.settle).not.toHaveBeenCalled();
  });

  it("a cleared manual bank payment (payment_intent.succeeded) settles it too", async () => {
    const res = await deliver("payment_intent.succeeded", {
      id: "pi_manual",
      metadata: { purpose: "household_charge", source_arbitration_v: "1", manual_ach: "1", charge_ids: CHARGE, manager_user_id: OWNER },
    });
    expect(res.status).toBe(200);
    expect(spies.settle).toHaveBeenCalledTimes(1);
    expect(spies.settle.mock.calls[0]![1]).toMatchObject({ chargeIds: [CHARGE], paymentIntentId: "pi_manual" });
  });

  it("answers 500 when the settlement throws, so Stripe redelivers (a refund is owed, not dropped)", async () => {
    spies.settle.mockRejectedValueOnce(new Error("no stripe charge yet"));
    const res = await deliver("checkout.session.completed", session());
    expect(res.status).toBe(500);
  });

  it("a redelivery calls the (idempotent) settlement again and still answers 200", async () => {
    await deliver("checkout.session.completed", session());
    const again = await deliver("checkout.session.completed", session());
    expect(again.status).toBe(200);
    expect(spies.settle).toHaveBeenCalledTimes(2);
  });
});
