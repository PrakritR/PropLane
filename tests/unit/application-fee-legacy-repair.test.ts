import { beforeEach, describe, expect, it, vi } from "vitest";

const syncLedger = vi.hoisted(() => vi.fn());
const syncCharge = vi.hoisted(() => vi.fn());
const creditSource = vi.hoisted(() => vi.fn());
const findHold = vi.hoisted(() => vi.fn());
const findIntentHold = vi.hoisted(() => vi.fn());
const cancelReminders = vi.hoisted(() => vi.fn());
const releaseSource = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerChargeOnlyEntry: syncCharge, syncLedgerPaymentEntry: syncLedger }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  findPlatformHold: findHold, findPlatformHoldByPaymentIntent: findIntentHold,
}));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({ cancelFuturePaymentRemindersForCharge: cancelReminders }));
vi.mock("@/lib/platform-hold-release.server", () => ({ releaseVerifiedPlatformHoldsForOwner: releaseSource }));

import { fulfillApplicationFeePayment } from "@/lib/application-fee-fulfillment.server";

const session = {
  id: "cs_historical", mode: "payment", status: "complete", payment_status: "paid",
  amount_total: 5175, amount_subtotal: 5175, currency: "usd", payment_intent: "pi_historical",
  customer_details: { email: "applicant@example.com" },
  metadata: {
    purpose: "rental_application_fee", manager_user_id: "manager-1", property_id: "property-1",
    resident_email: "applicant@example.com", fee_cents: "5000", subtotal_cents: "5000",
    processing_fee_cents: "175", service_fee_cents: "175", manager_payout_cents: "5000",
    fee_payer: "resident", platform_hold: "1", hold_amount_cents: "5000",
  },
};
const paidAt = "2026-10-04T03:00:00.000Z";
const savedCharge = {
  id: "hc_historical", kind: "application_fee", status: "paid",
  managerUserId: "manager-1", propertyId: "property-1", residentEmail: "applicant@example.com",
  residentUserId: null, propertyLabel: "Listing", title: "Application fee",
  amountLabel: "$50.00", balanceLabel: "$0.00", paidAt, paidAmountCents: 5175,
  stripeCheckoutSessionId: "cs_historical", stripePaymentStatus: "paid",
};
const chargeRow = {
  id: "hc_historical", manager_user_id: "manager-1", property_id: "property-1",
  resident_email: "applicant@example.com", kind: "application_fee", status: "paid",
  created_at: "2026-09-30T16:30:00.000Z",
  row_data: savedCharge,
};

describe("bound historical application fee financial repair", () => {
  let matches: typeof chargeRow[];
  let stripe: Record<string, unknown>;
  let db: Record<string, unknown>;
  let ledgerRows: { id: string }[];
  let persistedHold: Record<string, unknown> | null;
  beforeEach(() => {
    vi.clearAllMocks();
    matches = [chargeRow];
    ledgerRows = [{ id: "existing-payment-ledger" }];
    syncLedger.mockResolvedValue(undefined);
    syncCharge.mockResolvedValue(undefined);
    releaseSource.mockResolvedValue({ transferred: 0, pending: 1 });
    persistedHold = null;
    findHold.mockImplementation(async () => persistedHold?.sourceId === session.id ? persistedHold : null);
    findIntentHold.mockImplementation(async () => persistedHold);
    creditSource.mockImplementation(async () => {
      persistedHold ??= { id: "hold-historical", ownerUserId: "manager-1", ownerRole: "manager",
        source: "application_fee", sourceId: session.id,
        amountCents: 5000, status: "held", stripeChargeId: "ch_historical" };
      return { data: [{ hold_id: persistedHold.id, credited: true }], error: null };
    });
    cancelReminders.mockResolvedValue(undefined);
    db = {
      from: vi.fn((table: string) => {
        if (table === "portal_household_charge_records") {
          return { select: () => ({ eq: (_key: string, value: string) => ({
            limit: async () => ({ data: value === session.id ? matches : [], error: null }),
          }) }) };
        }
        if (table === "manager_property_records") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
            data: { manager_user_id: "manager-1" }, error: null,
          }) }) }) };
        }
        if (table === "ledger_entries") {
          const chain = { eq: vi.fn(), select: vi.fn().mockImplementation(async () => ({ data: ledgerRows, error: null })) };
          chain.eq.mockReturnValue(chain);
          return { update: vi.fn().mockReturnValue(chain) };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) =>
        name === "credit_verified_platform_hold" ? creditSource(args) : { data: true, error: null }),
    };
    stripe = {
      paymentIntents: { retrieve: vi.fn().mockResolvedValue({ id: "pi_historical", status: "succeeded",
        currency: "usd", amount_received: 5175, latest_charge: "ch_historical", transfer_data: null,
        metadata: { purpose: "rental_application_fee", manager_user_id: "manager-1",
          property_id: "property-1", resident_email: "applicant@example.com",
          platform_hold: "1", hold_amount_cents: "5000" },
      }) },
      charges: { retrieve: vi.fn().mockResolvedValue({ id: "ch_historical", payment_intent: "pi_historical",
        paid: true, status: "succeeded", currency: "usd", amount: 5175,
        amount_refunded: 0, refunded: false, disputed: false,
      }) },
      refunds: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
    };
  });

  it("repairs the exact existing payment ledger and manager hold without changing the charge or paid date", async () => {
    const first = await fulfillApplicationFeePayment(db as never, stripe as never, session as never);
    expect(first).toMatchObject({ legacy: true, chargeId: "hc_historical", alreadyPaid: true });
    expect(syncLedger).toHaveBeenCalledWith(expect.anything(), savedCharge, paidAt, session.id);
    expect(syncCharge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      id: savedCharge.id, createdAt: chargeRow.created_at,
    }));
    expect(syncCharge.mock.invocationCallOrder[0]).toBeLessThan(syncLedger.mock.invocationCallOrder[0]);
    expect(creditSource).toHaveBeenCalledWith(expect.objectContaining({
      p_owner: "manager-1", p_owner_role: "manager", p_source: "application_fee",
      p_source_id: "cs_historical", p_original_net: 5000,
      p_charge: "ch_historical", p_payment_intent: "pi_historical",
    }));
    expect((db.from as ReturnType<typeof vi.fn>).mock.calls.map(([table]) => table))
      .not.toContain("manager_application_records");
    await fulfillApplicationFeePayment(db as never, stripe as never, session as never);
    expect(syncLedger).toHaveBeenCalledTimes(2);
    expect(syncCharge).toHaveBeenCalledTimes(2);
    expect(creditSource).toHaveBeenCalledTimes(2);
  });

  it("reuses the canonical PI-first allocation on a Checkout-bound legacy replay", async () => {
    persistedHold = { id: "hold-pi-first", ownerUserId: "manager-1", ownerRole: "manager",
      source: "application_fee", sourceId: "pi_historical", amountCents: 5000,
      status: "held", stripeChargeId: "ch_historical" };
    const result = await fulfillApplicationFeePayment(db as never, stripe as never, session as never);
    expect(result).toMatchObject({ legacy: true, chargeId: "hc_historical" });
    expect(creditSource).toHaveBeenCalledOnce();
    expect(releaseSource).toHaveBeenCalledWith(db, { ownerUserId: "manager-1",
      holdId: "hold-pi-first", stripe });
    expect(findHold).toHaveBeenCalledWith(db, "application_fee", session.id);
    expect(findIntentHold).toHaveBeenCalledWith(db, "pi_historical");
  });

  it("keeps the same paid source retryable when charge/GL origin posting fails", async () => {
    syncCharge.mockRejectedValueOnce(new Error("origin ledger unavailable"));
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/origin ledger unavailable/);
    expect(syncLedger).not.toHaveBeenCalled();
    expect(creditSource).not.toHaveBeenCalled();
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ legacy: true, chargeId: savedCharge.id });
  });

  it("refuses to book historical income into the repair month without an origin date", async () => {
    matches = [{ ...chargeRow, created_at: "" }];
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/origin date needs review/);
    expect(syncCharge).not.toHaveBeenCalled();
    expect(syncLedger).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate, foreign, or differently priced paid sources", async () => {
    for (const candidate of [[], [chargeRow, chargeRow],
      [{ ...chargeRow, manager_user_id: "other-manager" }],
      [{ ...chargeRow, row_data: { ...savedCharge, amountLabel: "$40.00" } }]]) {
      matches = candidate;
      await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
        .rejects.toThrow();
    }
    expect(syncLedger).not.toHaveBeenCalled();
    expect(creditSource).not.toHaveBeenCalled();
  });

  it("rejects refund reservations and mismatched provider evidence before creating any hold", async () => {
    (stripe.refunds as { list: ReturnType<typeof vi.fn> }).list.mockResolvedValueOnce({
      data: [{ id: "re_pending", status: "pending" }], has_more: false,
    });
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/refund needs source review/);
    (stripe.paymentIntents as { retrieve: ReturnType<typeof vi.fn> }).retrieve.mockResolvedValueOnce({
      id: "pi_historical", status: "succeeded", currency: "usd", amount_received: 5175,
      latest_charge: "ch_historical", transfer_data: { destination: "acct_foreign" },
        metadata: { purpose: "rental_application_fee", manager_user_id: "manager-1",
          property_id: "property-1", resident_email: "applicant@example.com",
          platform_hold: "1", hold_amount_cents: "5000" },
    });
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/PaymentIntent does not match/);
    expect(syncLedger).not.toHaveBeenCalled();
    expect(creditSource).not.toHaveBeenCalled();
  });

  it("leaves a captured source retryable if ledger or hold repair fails", async () => {
    ledgerRows = [];
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/ledger needs repair/);
    expect(creditSource).not.toHaveBeenCalled();
    ledgerRows = [{ id: "existing-payment-ledger" }];
    creditSource.mockRejectedValueOnce(new Error("hold store unavailable"));
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/hold store unavailable/);
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ legacy: true });
  });
});
