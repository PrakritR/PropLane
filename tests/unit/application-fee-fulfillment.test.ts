import { beforeEach, describe, expect, it, vi } from "vitest";

const syncLedger = vi.hoisted(() => vi.fn());
const creditHold = vi.hoisted(() => vi.fn());
const findHold = vi.hoisted(() => vi.fn());
const cancelReminders = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerPaymentEntry: syncLedger }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({ creditPlatformHold: creditHold, findPlatformHold: findHold }));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({ cancelFuturePaymentRemindersForCharge: cancelReminders }));

import { fulfillClaimedApplicationFeePayment } from "@/lib/application-fee-fulfillment.server";

const claim = {
  application_id: "app_paid", attempt_token: "attempt-paid", manager_user_id: "manager-1",
  property_id: "property-1", resident_email: "resident@example.com", charge_id: "hc_app_paid",
  stripe_session_id: "cs_paid", stripe_charge_id: null, principal_cents: 500,
  processing_fee_cents: 44, payer_total_cents: 544, recipient_net_cents: 500,
  status: "pending", created_at: "2026-01-01T00:00:00Z",
  provider_params: { destinationAccountId: null, productDescription: "Listing",
    metadata: { resident_name: "Resident", fee_room_id: "room-1", fee_lease_term: "12 months", fee_source: "room_term" },
    fixedFeeBreakdown: { serviceFeeCents: 44 }, feePayer: "resident" },
};
const session = {
  id: "cs_paid", mode: "payment", status: "complete", payment_status: "paid",
  payment_intent: "pi_paid", amount_total: 544, currency: "usd",
  customer_details: { email: "resident@example.com" },
  metadata: { purpose: "rental_application_fee", application_id: "app_paid", attempt_token: "attempt-paid",
    manager_user_id: "manager-1", property_id: "property-1", resident_email: "resident@example.com",
    fee_cents: "500", subtotal_cents: "500", processing_fee_cents: "44", service_fee_cents: "44",
    manager_payout_cents: "500", fee_payer: "resident", platform_hold: "1", hold_amount_cents: "500",
    fee_room_id: "room-1", fee_lease_term: "12 months", fee_source: "room_term" },
};

describe("claimed application fee fulfillment", () => {
  let stored: Record<string, unknown> | null;
  let state: typeof claim;
  let settle: ReturnType<typeof vi.fn>;
  let stripe: Record<string, unknown>;
  let db: Record<string, unknown>;
  beforeEach(() => {
    vi.clearAllMocks();
    syncLedger.mockResolvedValue(undefined);
    creditHold.mockResolvedValue({ credited: true });
    findHold.mockResolvedValue(null);
    cancelReminders.mockResolvedValue(undefined);
    state = { ...claim };
    stored = null;
    settle = vi.fn(async (_name, args: { p_charge_row_data: Record<string, unknown> }) => {
      stored = args.p_charge_row_data;
      return { data: claim.charge_id, error: null };
    });
    db = {
      from: vi.fn((table: string) => {
        if (table === "ledger_entries") {
          const chain = { eq: vi.fn(), select: vi.fn().mockResolvedValue({ data: [{ id: "ledger-1" }], error: null }) };
          chain.eq.mockReturnValue(chain);
          return { update: vi.fn().mockReturnValue(chain) };
        }
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: table === "application_fee_payment_claims" ? state : stored ? { row_data: stored } : null,
          error: null,
        }) }) }) };
      }),
      rpc: settle,
    };
    stripe = {
      paymentIntents: { retrieve: vi.fn().mockResolvedValue({ id: "pi_paid", status: "succeeded", currency: "usd",
        amount_received: 544, latest_charge: "ch_paid", metadata: { purpose: "rental_application_fee",
          application_id: "app_paid", attempt_token: "attempt-paid", manager_user_id: "manager-1" } }) },
      charges: { retrieve: vi.fn().mockResolvedValue({ id: "ch_paid", payment_intent: "pi_paid", paid: true,
        status: "succeeded", currency: "usd", amount: 544, amount_refunded: 0,
        refunded: false, disputed: false, created: 1_768_000_000 }) },
      refunds: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
    };
  });

  it("uses the actual captured charge time and repairs ledger/hold on paid replay", async () => {
    const first = await fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never);
    expect(first).toMatchObject({ chargeId: "hc_app_paid", alreadyPaid: false });
    expect(stored?.paidAt).toBe(new Date(1_768_000_000_000).toISOString());
    expect(creditHold).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: "manager-1", sourceId: "cs_paid", stripeChargeId: "ch_paid", amountCents: 500,
    }));
    state = { ...state, status: "settled" };
    await fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never);
    expect(syncLedger).toHaveBeenCalledTimes(2);
    expect(creditHold).toHaveBeenCalledTimes(2);
  });

  it("fails a hold write so webhook/return can retry the same captured source", async () => {
    creditHold.mockRejectedValueOnce(new Error("hold write failed"));
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/hold write failed/);
    state = { ...state, status: "settled" };
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ alreadyPaid: true });
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("fails a ledger enrichment error instead of acknowledging an incomplete payment", async () => {
    const originalFrom = db.from as ReturnType<typeof vi.fn>;
    db.from = vi.fn((table: string) => {
      if (table !== "ledger_entries") return originalFrom(table);
      const chain = { eq: vi.fn(), select: vi.fn().mockResolvedValue({ data: null, error: { message: "ledger unavailable" } }) };
      chain.eq.mockReturnValue(chain);
      return { update: vi.fn().mockReturnValue(chain) };
    });
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/ledger enrichment needs repair/);
    expect(creditHold).not.toHaveBeenCalled();
  });

  it("does not settle unpaid, foreign-session, or mismatched provider amounts", async () => {
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never,
      { ...session, payment_status: "unpaid" } as never)).rejects.toThrow(/not a paid/);
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never,
      { ...session, id: "cs_foreign" } as never)).rejects.toThrow(/does not match/);
    (stripe.paymentIntents as { retrieve: ReturnType<typeof vi.fn> }).retrieve.mockResolvedValueOnce({
      id: "pi_paid", status: "succeeded", currency: "usd", amount_received: 500,
      latest_charge: "ch_paid", metadata: { purpose: "rental_application_fee",
        application_id: "app_paid", attempt_token: "attempt-paid", manager_user_id: "manager-1" },
    });
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/PaymentIntent does not match/);
    expect(settle).not.toHaveBeenCalled();
  });

  it("cannot recreate the original hold after a captured refund, including settled-claim replay", async () => {
    state = { ...state, status: "settled" };
    (stripe.charges as { retrieve: ReturnType<typeof vi.fn> }).retrieve.mockResolvedValue({
      id: "ch_paid", payment_intent: "pi_paid", paid: true, status: "succeeded",
      currency: "usd", amount: 544, amount_refunded: 100, refunded: false,
      disputed: false, created: 1_768_000_000,
    });
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/hold reconciliation/);
    expect(creditHold).not.toHaveBeenCalled();
    findHold.mockResolvedValue({ ownerUserId: "manager-1", ownerRole: "manager", status: "held",
      amountCents: 400, stripeChargeId: "ch_paid" });
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ alreadyPaid: true });
    expect(creditHold).not.toHaveBeenCalled();
    (stripe.charges as { retrieve: ReturnType<typeof vi.fn> }).retrieve.mockResolvedValue({
      id: "ch_paid", payment_intent: "pi_paid", paid: true, status: "succeeded",
      currency: "usd", amount: 544, amount_refunded: 544, refunded: true,
      disputed: false, created: 1_768_000_000,
    });
    findHold.mockResolvedValue(null);
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/hold reconciliation/);
  });

  it("does not rebook a paid source whose saved principal changed after settlement", async () => {
    await fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never);
    state = { ...state, status: "settled" };
    stored = { ...stored, amountLabel: "$7.00" };
    settle.mockResolvedValue({ data: claim.charge_id, error: null });
    syncLedger.mockClear(); creditHold.mockClear();
    await expect(fulfillClaimedApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/changed after provider settlement/);
    expect(syncLedger).not.toHaveBeenCalled();
    expect(creditHold).not.toHaveBeenCalled();
  });
});
