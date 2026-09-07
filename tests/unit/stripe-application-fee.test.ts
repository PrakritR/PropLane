import { describe, expect, it, vi } from "vitest";
import {
  includesHoldingDeposit,
  isApplicationFeeCheckoutSession,
  markApplicationDepositPaidFromStripeSession,
  markApplicationFeePaidFromStripeSession,
} from "@/lib/stripe-application-fee";

// GL posting is a separate concern (double-entry journal) exercised by its own
// unit tests — stub it here so the deposit-marking tests below only need to
// mock the `portal_household_charge_records` / `ledger_entries` chains they
// actually assert on.
vi.mock("@/lib/reports/gl-posting", () => ({
  postGlChargeEntry: vi.fn().mockResolvedValue(null),
  postGlPaymentEntry: vi.fn().mockResolvedValue(null),
}));

const ensureApplicationFeeChargeRow = vi.fn();
vi.mock("@/lib/resident-check-manual-payment.server", () => ({
  ensureApplicationFeeChargeRow: (...args: unknown[]) => ensureApplicationFeeChargeRow(...args),
}));

vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  cancelFuturePaymentRemindersForCharge: vi.fn().mockResolvedValue(undefined),
  restoreFuturePaymentRemindersForCharge: vi.fn().mockResolvedValue(undefined),
}));

describe("stripe-application-fee", () => {
  it("identifies application fee sessions", () => {
    expect(
      isApplicationFeeCheckoutSession({ metadata: { purpose: "rental_application_fee" } } as never),
    ).toBe(true);
    expect(isApplicationFeeCheckoutSession({ metadata: {} } as never)).toBe(false);
  });

  it("identifies sessions that combined a holding deposit", () => {
    expect(
      includesHoldingDeposit({ metadata: { includes_holding_deposit: "true" } } as never),
    ).toBe(true);
    expect(includesHoldingDeposit({ metadata: {} } as never)).toBe(false);
  });
});

describe("markApplicationFeePaidFromStripeSession", () => {
  const session = {
    id: "cs_test_1",
    payment_status: "paid",
    metadata: {
      purpose: "rental_application_fee",
      property_id: "prop-1",
      resident_email: "res@test.com",
    },
  } as never;

  const paidCharge = {
    id: "hc-1",
    kind: "application_fee",
    propertyId: "prop-1",
    managerUserId: "3b9c2c65-6f0f-4d3a-9a3e-0b7f6f8a1c2d",
    residentUserId: null,
    residentEmail: "res@test.com",
    propertyLabel: "Unit 1",
    status: "paid",
    paidAt: "2026-01-02T00:00:00.000Z",
    amountLabel: "$50.00",
    balanceLabel: "$0.00",
    title: "Application fee",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  function makeDb(ledgerInsert: ReturnType<typeof vi.fn>) {
    const chargeEq = vi.fn().mockResolvedValue({
      data: [{ id: "hc-1", row_data: paidCharge, status: "paid" }],
      error: null,
    });
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const ledgerEq2 = vi.fn().mockReturnValue({ maybeSingle });
    const ledgerEq1 = vi.fn().mockReturnValue({ eq: ledgerEq2 });
    const from = vi.fn((table: string) => {
      if (table === "portal_household_charge_records") {
        return { select: vi.fn().mockReturnValue({ eq: chargeEq }) };
      }
      return { select: vi.fn().mockReturnValue({ eq: ledgerEq1 }), insert: ledgerInsert };
    });
    return { db: { from } as never, chargeEq };
  }

  it("finds an already-paid charge on retry and heals its ledger entry", async () => {
    const ledgerInsert = vi.fn().mockResolvedValue({ error: null });
    const { db } = makeDb(ledgerInsert);

    const result = await markApplicationFeePaidFromStripeSession(db, session);
    expect(result).toEqual({ ok: true, chargeId: "hc-1", alreadyPaid: true, created: false });
    expect(ensureApplicationFeeChargeRow).not.toHaveBeenCalled();
    expect(ledgerInsert).toHaveBeenCalledTimes(1);
    expect(ledgerInsert.mock.calls[0][0]).toMatchObject({
      entry_type: "payment",
      source_charge_id: "hc-1",
      amount_cents: 5000,
    });
  });

  it("still reports success when the already-paid heal fails transiently", async () => {
    const ledgerInsert = vi.fn().mockResolvedValue({ error: { message: "transient" } });
    const { db } = makeDb(ledgerInsert);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await markApplicationFeePaidFromStripeSession(db, session);
    expect(result).toEqual({ ok: true, chargeId: "hc-1", alreadyPaid: true, created: false });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("PRP-428: creates a fee row when none exists, then marks it paid", async () => {
    const pending = {
      id: "hc_app_fee_res_test_com_prop_1",
      kind: "application_fee" as const,
      propertyId: "prop-1",
      managerUserId: "3b9c2c65-6f0f-4d3a-9a3e-0b7f6f8a1c2d",
      residentUserId: null,
      residentEmail: "res@test.com",
      propertyLabel: "Unit 1",
      status: "pending" as const,
      amountLabel: "$50.00",
      balanceLabel: "$50.00",
      title: "Application fee",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    ensureApplicationFeeChargeRow.mockResolvedValue({
      id: pending.id,
      row_data: pending,
      status: "pending",
      manager_user_id: pending.managerUserId,
    });

    const chargeEq = vi.fn().mockResolvedValue({ data: [], error: null });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const ledgerInsert = vi.fn((row: unknown) => {
      return {
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: "ledger-1" }, error: null }),
        }),
      };
    });
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const ledgerEq2 = vi.fn().mockReturnValue({ maybeSingle });
    const ledgerEq1 = vi.fn().mockReturnValue({ eq: ledgerEq2 });
    const from = vi.fn((table: string) => {
      if (table === "portal_household_charge_records") {
        return { select: vi.fn().mockReturnValue({ eq: chargeEq }), upsert };
      }
      return { select: vi.fn().mockReturnValue({ eq: ledgerEq1 }), insert: ledgerInsert };
    });
    const db = { from } as never;

    const result = await markApplicationFeePaidFromStripeSession(db, session);
    expect(ensureApplicationFeeChargeRow).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ residentEmail: "res@test.com", propertyId: "prop-1" }),
    );
    expect(result).toMatchObject({ ok: true, chargeId: pending.id, created: true });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      id: pending.id,
      kind: "application_fee",
      status: "paid",
    });
  });
});

describe("markApplicationDepositPaidFromStripeSession", () => {
  const combinedSession = {
    id: "cs_test_2",
    payment_status: "paid",
    metadata: {
      purpose: "rental_application_fee",
      property_id: "prop-1",
      resident_email: "res@test.com",
      includes_holding_deposit: "true",
      holding_deposit_cents: "10000",
    },
  } as never;

  const pendingDepositCharge = {
    id: "hc-deposit-1",
    kind: "holding_deposit",
    propertyId: "prop-1",
    managerUserId: "3b9c2c65-6f0f-4d3a-9a3e-0b7f6f8a1c2d",
    residentUserId: null,
    residentEmail: "res@test.com",
    propertyLabel: "Unit 1",
    status: "pending",
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    title: "Holding deposit",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  function makeDepositDb(row: typeof pendingDepositCharge, ledgerInsert: ReturnType<typeof vi.fn>) {
    const chargeEq = vi.fn().mockResolvedValue({ data: [{ id: row.id, row_data: row, status: row.status }], error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const ledgerEq2 = vi.fn().mockReturnValue({ maybeSingle });
    const ledgerEq1 = vi.fn().mockReturnValue({ eq: ledgerEq2 });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    // `upsertLedgerEntryRow` chains `.insert(row).select("id").single()` on a
    // fresh insert — `ledgerInsert` records the call, the chain resolves it.
    const insertChain = vi.fn((row: unknown) => {
      ledgerInsert(row);
      return { select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: "ledger-1" }, error: null }) }) };
    });
    const from = vi.fn((table: string) => {
      if (table === "portal_household_charge_records") {
        return { select: vi.fn().mockReturnValue({ eq: chargeEq }), upsert };
      }
      return { select: vi.fn().mockReturnValue({ eq: ledgerEq1 }), insert: insertChain };
    });
    return { db: { from } as never, upsert };
  }

  it("is a no-op on a session that never combined a deposit", async () => {
    const { db, upsert } = makeDepositDb(pendingDepositCharge, vi.fn());
    const plainFeeSession = {
      id: "cs_x",
      payment_status: "paid",
      metadata: { purpose: "rental_application_fee", property_id: "prop-1", resident_email: "res@test.com" },
    } as never;

    const result = await markApplicationDepositPaidFromStripeSession(db, plainFeeSession);
    expect(result).toEqual({ ok: false });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("marks the pending holding-deposit charge paid and posts the ledger entry", async () => {
    const ledgerInsert = vi.fn().mockResolvedValue({ error: null });
    const { db, upsert } = makeDepositDb(pendingDepositCharge, ledgerInsert);

    const result = await markApplicationDepositPaidFromStripeSession(db, combinedSession);
    expect(result.ok).toBe(true);
    expect(result.chargeId).toBe("hc-deposit-1");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [row] = upsert.mock.calls[0];
    expect(row).toMatchObject({ id: "hc-deposit-1", kind: "holding_deposit", status: "paid" });
    expect(ledgerInsert).toHaveBeenCalledTimes(1);
    expect(ledgerInsert.mock.calls[0][0]).toMatchObject({
      entry_type: "payment",
      source_charge_id: "hc-deposit-1",
      amount_cents: 10000,
    });
  });

  it("heals the ledger on retry when the deposit charge is already paid", async () => {
    const ledgerInsert = vi.fn().mockResolvedValue({ error: null });
    const { db, upsert } = makeDepositDb(
      { ...pendingDepositCharge, status: "paid", paidAt: "2026-01-02T00:00:00.000Z" },
      ledgerInsert,
    );

    const result = await markApplicationDepositPaidFromStripeSession(db, combinedSession);
    expect(result).toEqual({ ok: true, chargeId: "hc-deposit-1", alreadyPaid: true });
    expect(upsert).not.toHaveBeenCalled();
    expect(ledgerInsert).toHaveBeenCalledTimes(1);
  });
});
