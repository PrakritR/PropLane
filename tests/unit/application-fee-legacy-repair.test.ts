import { beforeEach, describe, expect, it, vi } from "vitest";

const syncLedger = vi.hoisted(() => vi.fn());
const creditHold = vi.hoisted(() => vi.fn());
const findHold = vi.hoisted(() => vi.fn());
const cancelReminders = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerPaymentEntry: syncLedger }));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  creditPlatformHold: creditHold, findPlatformHold: findHold,
}));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({ cancelFuturePaymentRemindersForCharge: cancelReminders }));

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
  row_data: savedCharge,
};

describe("bound historical application fee financial repair", () => {
  let matches: typeof chargeRow[];
  let stripe: Record<string, unknown>;
  let db: Record<string, unknown>;
  let ledgerRows: { id: string }[];
  beforeEach(() => {
    vi.clearAllMocks();
    matches = [chargeRow];
    ledgerRows = [{ id: "existing-payment-ledger" }];
    syncLedger.mockResolvedValue(undefined);
    findHold.mockResolvedValue(null);
    creditHold.mockResolvedValue({ credited: true });
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
    expect(creditHold).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId: "manager-1", ownerRole: "manager", source: "application_fee",
      sourceId: "cs_historical", amountCents: 5000, stripeChargeId: "ch_historical",
    });
    expect((db.from as ReturnType<typeof vi.fn>).mock.calls.map(([table]) => table))
      .not.toContain("manager_application_records");
    await fulfillApplicationFeePayment(db as never, stripe as never, session as never);
    expect(syncLedger).toHaveBeenCalledTimes(2);
    expect(creditHold).toHaveBeenCalledTimes(2);
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
    expect(creditHold).not.toHaveBeenCalled();
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
    expect(creditHold).not.toHaveBeenCalled();
  });

  it("leaves a captured source retryable if ledger or hold repair fails", async () => {
    ledgerRows = [];
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/ledger needs repair/);
    expect(creditHold).not.toHaveBeenCalled();
    ledgerRows = [{ id: "existing-payment-ledger" }];
    creditHold.mockRejectedValueOnce(new Error("hold store unavailable"));
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .rejects.toThrow(/hold store unavailable/);
    await expect(fulfillApplicationFeePayment(db as never, stripe as never, session as never))
      .resolves.toMatchObject({ legacy: true });
  });
});
