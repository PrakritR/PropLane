import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findHold: vi.fn(), findHistoricalHold: vi.fn(), verifySource: vi.fn(), release: vi.fn(),
  settle: vi.fn(), availability: vi.fn(),
}));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  findPlatformHoldByPaymentIntent: mocks.findHold,
  findPlatformHold: mocks.findHistoricalHold,
}));
vi.mock("@/lib/platform-hold-release.server", () => ({
  verifyPlatformHoldSourceRefundHistory: mocks.verifySource,
  releaseVerifiedPlatformHoldsForOwner: mocks.release,
}));
vi.mock("@/lib/platform-owner-recovery.server", () => ({
  settleClearedPlatformOwnerRecovery: mocks.settle,
  verifiedCapturedChargeAvailability: mocks.availability,
}));

import { creditVerifiedHouseholdCheckoutSource,
  creditVerifiedHouseholdAutopaySource,
  creditVerifiedHouseholdManualSource,
  assertFreshHouseholdCapturedSource,
  verifyExistingHistoricalHouseholdHold } from "@/lib/household-captured-source.server";

const checkoutMeta = {
  source_arbitration_v: "1", purpose: "household_charge", charge_id: "hc_rent",
  charge_ids: "hc_rent,hc_deposit", manager_user_id: "manager-1",
  fee_payer: "manager", subtotal_cents: "300", processing_fee_cents: "0",
  manager_payout_cents: "270", platform_hold: "1", hold_amount_cents: "270",
};
const session = { id: "cs_paid", mode: "payment", status: "complete",
  payment_status: "paid", currency: "usd", amount_total: 300,
  payment_intent: "pi_paid", metadata: checkoutMeta };
const pi = { id: "pi_paid", status: "succeeded", currency: "usd", amount: 300, amount_received: 300,
  latest_charge: "ch_paid", metadata: checkoutMeta };
const charge = { id: "ch_paid", payment_intent: "pi_paid", paid: true, captured: true,
  status: "succeeded", currency: "usd", amount: 300, amount_refunded: 0,
  refunded: false, disputed: false };
const rows = [
  { id: "hc_rent", manager_user_id: "manager-1", kind: "rent", status: "paid",
    row_data: { id: "hc_rent", managerUserId: "manager-1", kind: "rent",
      status: "paid", amountLabel: "$2.00", balanceLabel: "$0.00",
      paidAmountCents: 200, stripeCheckoutSessionId: "cs_paid" } },
  { id: "hc_deposit", manager_user_id: "manager-1", kind: "security_deposit", status: "paid",
    row_data: { id: "hc_deposit", managerUserId: "manager-1", kind: "security_deposit",
      status: "paid", amountLabel: "$1.00", balanceLabel: "$0.00",
      paidAmountCents: 100, stripeCheckoutSessionId: "cs_paid" } },
];

function fixture(savedRows: typeof rows = rows) {
  const rpc = vi.fn(async () => ({ data: [{ hold_id: "hold-paid", credited: true,
    reserved_cents: 0 }], error: null }));
  const db = { rpc, from: vi.fn((table: string) => {
    if (table !== "portal_household_charge_records") {
      throw new Error(`unexpected table: ${table}`);
    }
    return { select: () => ({ in: async () => ({ data: savedRows, error: null }) }) };
  }) };
  const stripe = {
    paymentIntents: { retrieve: vi.fn(async () => pi) },
    charges: { retrieve: vi.fn(async () => charge) },
    refunds: { list: vi.fn(async () => ({ data: [], has_more: false })) },
  };
  return { db, stripe, rpc };
}

describe("versioned household captured sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findHold.mockResolvedValue(null);
    mocks.findHistoricalHold.mockResolvedValue(null);
    mocks.availability.mockResolvedValue({ availableOn: "2026-10-06T00:00:00.000Z",
      balanceTransactionId: "txn_paid", status: "pending" });
    mocks.settle.mockResolvedValue({ settled: 0, pending: 0 });
    mocks.release.mockResolvedValue({ transferred: 0, pending: 1 });
  });

  it("validates the whole paid cart and freezes income/deposit component nets", async () => {
    const f = fixture();
    await creditVerifiedHouseholdCheckoutSource(f.db as never, f.stripe as never,
      session as never);
    expect(f.rpc).toHaveBeenCalledWith("credit_platform_income_with_recovery",
      expect.objectContaining({ p_owner: "manager-1", p_charge: "ch_paid",
        p_principal: 300, p_original_net: 270,
        p_available_on: "2026-10-06T00:00:00.000Z",
        p_components: [
          { source_id: "hc_deposit", kind: "security_deposit", liability_class: "deposit",
            principal_cents: 100, recipient_net_cents: 90 },
          { source_id: "hc_rent", kind: "rent", liability_class: "income",
            principal_cents: 200, recipient_net_cents: 180 },
        ] }));
    expect(mocks.settle).toHaveBeenCalledBefore(mocks.release);
  });

  it("attests the captured provider source before any paid-row read", async () => {
    const f = fixture();
    expect(await assertFreshHouseholdCapturedSource(f.stripe as never,
      { checkoutSession: session as never })).toMatchObject({
      paymentIntent: { id: "pi_paid" }, charge: { id: "ch_paid" } });
    expect(f.db.from).not.toHaveBeenCalled();
    f.stripe.refunds.list.mockResolvedValueOnce({ data: [{ id: "re_unknown" }], has_more: false });
    await expect(assertFreshHouseholdCapturedSource(f.stripe as never,
      { checkoutSession: session as never })).rejects.toThrow(/refund evidence/);
    f.stripe.charges.retrieve.mockResolvedValueOnce({ ...charge, disputed: true });
    await expect(assertFreshHouseholdCapturedSource(f.stripe as never,
      { checkoutSession: session as never })).rejects.toThrow(/Charge differs/);
    expect(f.db.from).not.toHaveBeenCalled();
  });

  it("refuses a cart with one foreign paid row before any source credit", async () => {
    const f = fixture([rows[0]!, { ...rows[1]!, manager_user_id: "other" }]);
    await expect(creditVerifiedHouseholdCheckoutSource(f.db as never, f.stripe as never,
      session as never)).rejects.toThrow(/captured owner or source/);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("rejects a paid row whose principal includes a processing fee", async () => {
    const f = fixture([{ ...rows[0]!, row_data: { ...rows[0]!.row_data,
      paidAmountCents: 201 } }, rows[1]!]);
    await expect(creditVerifiedHouseholdCheckoutSource(f.db as never, f.stripe as never,
      session as never)).rejects.toThrow(/exact saved principal/);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("refuses an unrecorded provider refund before creating a central source", async () => {
    const f = fixture();
    f.stripe.refunds.list.mockResolvedValue({ data: [{ id: "re_unknown" }], has_more: false });
    await expect(creditVerifiedHouseholdCheckoutSource(f.db as never, f.stripe as never,
      session as never)).rejects.toThrow(/allocation reconciliation/);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("requires the durable autopay run and single paid charge before credit", async () => {
    const f = fixture();
    const autopay = { ...pi, metadata: { ...checkoutMeta, charge_id: "hc_rent",
      charge_ids: undefined, autopay_run_id: "run-paid", principal_cents: "200",
      processing_fee_cents: "0", manager_payout_cents: "180",
      hold_amount_cents: "180" }, amount: 200, amount_received: 200 };
    const autopayCharge = { ...charge, amount: 200 };
    f.stripe.charges.retrieve.mockResolvedValue(autopayCharge);
    f.db.from = vi.fn((table: string) => {
      const data = table === "resident_autopay_runs"
        ? { id: "run-paid", charge_id: "hc_rent", manager_id: "manager-1",
          stripe_payment_intent_id: null }
        : { ...rows[0]!, row_data: { ...rows[0]!.row_data,
          stripeCheckoutSessionId: "pi_paid" } };
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) };
    });
    await creditVerifiedHouseholdAutopaySource(f.db as never, f.stripe as never,
      autopay as never, "hc_rent");
    expect(f.rpc).toHaveBeenCalledWith("credit_platform_income_with_recovery",
      expect.objectContaining({ p_source_id: "pi_paid", p_original_net: 180 }));
  });

  it("uses the marked manual bank PI as the exact cart source after paid settlement", async () => {
    const paidRows = rows.map((row) => ({ ...row, row_data: {
      ...row.row_data, stripeCheckoutSessionId: "pi_paid" } }));
    const f = fixture(paidRows);
    const manualPi = { ...pi, metadata: { ...checkoutMeta,
      manual_ach: "1", principal_cents: "300", total_cents: "300" } };
    f.stripe.paymentIntents.retrieve.mockResolvedValue(manualPi);
    await assertFreshHouseholdCapturedSource(f.stripe as never,
      { paymentIntent: manualPi as never });
    expect(f.db.from).not.toHaveBeenCalled();
    await creditVerifiedHouseholdManualSource(f.db as never, f.stripe as never,
      manualPi as never);
    expect(f.rpc).toHaveBeenCalledWith("credit_platform_income_with_recovery",
      expect.objectContaining({ p_source_id: "pi_paid", p_payment_intent: "pi_paid",
        p_principal: 300, p_original_net: 270 }));
  });

  it("fails closed for an unmarked paid Checkout without an existing exact hold", async () => {
    const f = fixture();
    f.stripe.paymentIntents.retrieve.mockResolvedValue({ ...pi,
      metadata: { manager_user_id: "manager-1" } });
    await expect(verifyExistingHistoricalHouseholdHold(f.db as never, f.stripe as never,
      { ...session, metadata: { ...checkoutMeta,
        source_arbitration_v: undefined } } as never)).rejects.toThrow(/hold reconciliation/);
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
