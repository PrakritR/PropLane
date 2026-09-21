import { describe, expect, it, vi } from "vitest";
import {
  axisAchPlatformFeeCents,
  householdChargeAmountCents,
  isHouseholdChargeCheckoutSession,
  markHouseholdChargePaidFromStripeSession,
} from "@/lib/stripe-household-charge";
import type { HouseholdCharge } from "@/lib/household-charges";

vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  cancelFuturePaymentRemindersForCharge: vi.fn(async () => undefined),
}));
vi.mock("@/lib/push-notifications.server", () => ({
  sendPushToUser: vi.fn(async () => undefined),
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

describe("stripe-household-charge", () => {
  it("resident-pays application fee on an ACH charge is Stripe's 0.8% cost", () => {
    // axisAchPlatformFeeCents is the resident-pays Connect application fee (the
    // service fee retained), so it equals Stripe's 0.8% ACH cost on $100.
    expect(axisAchPlatformFeeCents(10000)).toBe(80);
    expect(axisAchPlatformFeeCents(0)).toBe(0);
  });

  it("parses charge amount cents", () => {
    const charge = { balanceLabel: "$150.00", amountLabel: "$150.00" } as HouseholdCharge;
    expect(householdChargeAmountCents(charge)).toBe(15000);
  });

  it("identifies household charge checkout sessions", () => {
    expect(isHouseholdChargeCheckoutSession({ metadata: { purpose: "household_charge" } } as never)).toBe(true);
    expect(isHouseholdChargeCheckoutSession({ metadata: {} } as never)).toBe(false);
  });
});

describe("markHouseholdChargePaidFromStripeSession — already-paid heal", () => {
  const session = {
    id: "cs_test_hc",
    payment_status: "paid",
    metadata: { purpose: "household_charge", charge_ids: "hc-1" },
  } as never;

  const paidCharge = {
    id: "hc-1",
    kind: "rent",
    propertyId: "prop-1",
    managerUserId: "3b9c2c65-6f0f-4d3a-9a3e-0b7f6f8a1c2d",
    residentUserId: null,
    residentEmail: "res@test.com",
    propertyLabel: "Unit 1",
    status: "paid",
    paidAt: "2026-01-02T00:00:00.000Z",
    amountLabel: "$1,200.00",
    balanceLabel: "$0.00",
    title: "Monthly rent",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  function makeDb(ledgerInsert: ReturnType<typeof vi.fn>) {
    const maybeSingleCharge = vi.fn().mockResolvedValue({
      data: { id: "hc-1", row_data: paidCharge, status: "paid" },
      error: null,
    });
    const chargeEq = vi.fn().mockReturnValue({ maybeSingle: maybeSingleCharge });
    const maybeSingleLedger = vi.fn().mockResolvedValue({ data: null, error: null });
    const ledgerEq2 = vi.fn().mockReturnValue({ maybeSingle: maybeSingleLedger });
    const ledgerEq1 = vi.fn().mockReturnValue({ eq: ledgerEq2 });
    const from = vi.fn((table: string) => {
      if (table === "portal_household_charge_records") {
        return { select: vi.fn().mockReturnValue({ eq: chargeEq }) };
      }
      return { select: vi.fn().mockReturnValue({ eq: ledgerEq1 }), insert: ledgerInsert };
    });
    return { db: from as never as Parameters<typeof markHouseholdChargePaidFromStripeSession>[0], from };
  }

  it("re-syncs the payment ledger entry when webhook redelivery hits an already-paid charge", async () => {
    const ledgerInsert = vi.fn().mockResolvedValue({ error: null });
    const { from } = makeDb(ledgerInsert);

    const result = await markHouseholdChargePaidFromStripeSession({ from } as never, session);
    expect(result).toEqual({ ok: true, chargeId: "hc-1", alreadyPaid: true });
    expect(ledgerInsert).toHaveBeenCalledTimes(1);
    expect(ledgerInsert.mock.calls[0][0]).toMatchObject({
      entry_type: "payment",
      source_charge_id: "hc-1",
      amount_cents: 120000,
      stripe_checkout_session_id: "cs_test_hc",
    });
  });

  it("still reports success when the already-paid heal fails transiently", async () => {
    const ledgerInsert = vi.fn().mockResolvedValue({ error: { message: "transient" } });
    const { from } = makeDb(ledgerInsert);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await markHouseholdChargePaidFromStripeSession({ from } as never, session);
    expect(result).toEqual({ ok: true, chargeId: "hc-1", alreadyPaid: true });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
