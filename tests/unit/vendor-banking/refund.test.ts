import { describe, expect, it, vi } from "vitest";
import { makeFakeDb, type Row } from "./_fake-db";
import { refundVendorPayout, previewVendorRefund } from "@/lib/vendor-banking/refund.server";

function destinationPayout(overrides: Partial<Row> = {}): Row {
  return {
    id: "payout_1",
    manager_user_id: "manager_1",
    vendor_user_id: "vendor_1",
    work_order_id: "wo_1",
    invoice_id: null,
    amount_cents: 10_000,
    platform_fee_cents: 300, // 3% of 10,000
    refunded_gross_cents: 0,
    refunded_fee_cents: 0,
    status: "paid",
    destination: "destination_charge",
    stripe_charge_id: "ch_1",
    stripe_transfer_id: "cs_1",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeStripe(overrides: Partial<{ refundsCreate: unknown; reversalCreate: unknown }> = {}) {
  return {
    refunds: { create: overrides.refundsCreate ?? vi.fn().mockResolvedValue({ id: "re_1" }) },
    transfers: { createReversal: overrides.reversalCreate ?? vi.fn().mockResolvedValue({ id: "trr_1" }) },
  } as unknown as import("stripe").default;
}

describe("previewVendorRefund", () => {
  it("computes the proportional fee share and net debit", () => {
    const p = previewVendorRefund({ amountCents: 10_000, platformFeeCents: 300, refundedGrossCents: 0 }, 5_000);
    expect(p).toEqual({ requestedGrossCents: 5_000, feeShareCents: 150, netDebitCents: 4_850, managerReceivesCents: 5_000 });
  });

  it("clamps the requested amount to what's still refundable", () => {
    const p = previewVendorRefund({ amountCents: 10_000, platformFeeCents: 300, refundedGrossCents: 6_000 }, 999_999);
    expect(p.requestedGrossCents).toBe(4_000); // 10000 - 6000 refundable
  });
});

describe("refundVendorPayout — auth / ownership", () => {
  it("vendor A cannot refund vendor B's payment (row simply doesn't resolve)", async () => {
    const db = makeFakeDb({ vendor_payouts: [destinationPayout({ vendor_user_id: "vendor_B" })] });
    const result = await refundVendorPayout(makeStripe(), db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_A",
      idempotencyKey: "idem_1",
    });
    expect(result).toEqual({ ok: false, status: 404, error: "Payment not found." });
  });
});

describe("refundVendorPayout — partial math (destination charge)", () => {
  it("a partial refund: reverse_transfer + refund_application_fee, proportional fee, ledger lines match", async () => {
    const db = makeFakeDb({ vendor_payouts: [destinationPayout()] });
    const stripe = makeStripe();
    const result = await refundVendorPayout(stripe, db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      requestedGrossCents: 4_000,
      idempotencyKey: "idem_2",
    });
    expect(result).toEqual({
      ok: true,
      status: "partially_refunded",
      requestedGrossCents: 4_000,
      feeShareCents: 120, // 4000 * 300/10000
      netDebitCents: 3_880,
      shortfallCents: 0,
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_1", amount: 4_000, reverse_transfer: true, refund_application_fee: true }),
      { idempotencyKey: "idem_2:refund" },
    );
    const payoutRow = db._tables.vendor_payouts![0]!;
    expect(payoutRow.refunded_gross_cents).toBe(4_000);
    expect(payoutRow.refunded_fee_cents).toBe(120);
    expect(payoutRow.status).toBe("partially_refunded");

    const refundLine = db._inserts.find((i) => i.table === "vendor_banking_ledger_entries" && i.row.kind === "refund");
    expect(refundLine?.row.amount_cents).toBe(-3_880);
    const feeLine = db._inserts.find((i) => i.table === "vendor_banking_ledger_entries" && i.row.kind === "adjustment" && (i.row.description as string).includes("fee refunded"));
    expect(feeLine?.row.amount_cents).toBe(120);
  });

  it("a full refund flips status to refunded", async () => {
    const db = makeFakeDb({ vendor_payouts: [destinationPayout()] });
    const result = await refundVendorPayout(makeStripe(), db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      idempotencyKey: "idem_3",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("refunded");
      expect(result.requestedGrossCents).toBe(10_000);
      expect(result.feeShareCents).toBe(300);
    }
  });
});

describe("refundVendorPayout — over-refund rejected", () => {
  it("refusing a request above what's still refundable", async () => {
    const db = makeFakeDb({ vendor_payouts: [destinationPayout({ refunded_gross_cents: 7_000 })] });
    const result = await refundVendorPayout(makeStripe(), db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      requestedGrossCents: 5_000, // only 3000 left
      idempotencyKey: "idem_4",
    });
    expect(result).toEqual({ ok: false, status: 422, error: "At most $30.00 can still be refunded." });
  });

  it("refusing a payment whose status is already refunded", async () => {
    const db = makeFakeDb({ vendor_payouts: [destinationPayout({ refunded_gross_cents: 10_000, status: "refunded" })] });
    const result = await refundVendorPayout(makeStripe(), db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      idempotencyKey: "idem_5",
    });
    expect(result).toEqual({ ok: false, status: 409, error: "This payment is refunded and cannot be refunded." });
  });

  it("refusing a partially_refunded payment with nothing left (defense in depth beyond the status check)", async () => {
    const db = makeFakeDb({
      vendor_payouts: [destinationPayout({ refunded_gross_cents: 10_000, status: "partially_refunded" })],
    });
    const result = await refundVendorPayout(makeStripe(), db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      idempotencyKey: "idem_5b",
    });
    expect(result).toEqual({ ok: false, status: 409, error: "This payment has already been fully refunded." });
  });

  it("refusing a pending (not yet settled) payout", async () => {
    const db = makeFakeDb({ vendor_payouts: [destinationPayout({ status: "pending" })] });
    const result = await refundVendorPayout(makeStripe(), db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      idempotencyKey: "idem_6",
    });
    expect(result).toEqual({ ok: false, status: 409, error: "This payment is pending and cannot be refunded." });
  });

  it("rejects a zero or negative amount", async () => {
    const db = makeFakeDb({ vendor_payouts: [destinationPayout()] });
    const result = await refundVendorPayout(makeStripe(), db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      requestedGrossCents: 0,
      idempotencyKey: "idem_7",
    });
    expect(result).toEqual({ ok: false, status: 400, error: "Enter an amount greater than $0." });
  });
});

describe("refundVendorPayout — held (not yet transferred)", () => {
  it("refunds the platform charge only, no transfer reversal needed, and marks the hold refunded on a full refund", async () => {
    const db = makeFakeDb({
      vendor_payouts: [destinationPayout({ destination: "hold", stripe_transfer_id: null })],
      platform_payment_holds: [
        {
          id: "hold_1",
          owner_user_id: "vendor_1",
          owner_role: "vendor",
          source: "vendor_invoice",
          source_id: "wo_1",
          amount_cents: 9_700,
          status: "held",
          stripe_charge_id: "ch_1",
          stripe_transfer_id: null,
        },
      ],
    });
    const stripe = makeStripe();
    const result = await refundVendorPayout(stripe, db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      idempotencyKey: "idem_8",
    });
    expect(result.ok).toBe(true);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { charge: "ch_1", amount: 10_000, reason: undefined },
      { idempotencyKey: "idem_8:refund" },
    );
    expect(stripe.transfers.createReversal).not.toHaveBeenCalled();
    const holdRow = db._tables.platform_payment_holds![0]!;
    expect(holdRow.status).toBe("refunded");
  });
});

describe("refundVendorPayout — held then already transferred", () => {
  it("refunds the platform charge AND reverses the hold's own separate transfer", async () => {
    const db = makeFakeDb({
      vendor_payouts: [destinationPayout({ destination: "hold", stripe_transfer_id: null })],
      platform_payment_holds: [
        {
          id: "hold_1",
          owner_user_id: "vendor_1",
          owner_role: "vendor",
          source: "vendor_invoice",
          source_id: "wo_1",
          amount_cents: 9_700,
          status: "transferred",
          stripe_charge_id: "ch_1",
          stripe_transfer_id: "tr_hold_1",
        },
      ],
    });
    const stripe = makeStripe();
    const result = await refundVendorPayout(stripe, db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      requestedGrossCents: 5_000,
      idempotencyKey: "idem_9",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.shortfallCents).toBe(0);
    expect(stripe.transfers.createReversal).toHaveBeenCalledWith(
      "tr_hold_1",
      { amount: 4_850 }, // 5000 - 150 fee share
      { idempotencyKey: "idem_9:reversal" },
    );
  });

  it("shortfall: when the reversal fails (insufficient balance), the manager is still refunded and the shortfall is recorded", async () => {
    const db = makeFakeDb(
      {
        vendor_payouts: [destinationPayout({ destination: "hold", stripe_transfer_id: null })],
        platform_payment_holds: [
          {
            id: "hold_1",
            owner_user_id: "vendor_1",
            owner_role: "vendor",
            source: "vendor_invoice",
            source_id: "wo_1",
            amount_cents: 9_700,
            status: "transferred",
            stripe_charge_id: "ch_1",
            stripe_transfer_id: "tr_hold_1",
          },
        ],
      },
      {
        vendor_banking_add_shortfall: (params) => ({ data: Number(params.p_cents), error: null }),
      },
    );
    const stripe = makeStripe({ reversalCreate: vi.fn().mockRejectedValue(new Error("insufficient funds")) });
    const result = await refundVendorPayout(stripe, db as never, {
      payoutId: "payout_1",
      vendorUserId: "vendor_1",
      requestedGrossCents: 5_000,
      idempotencyKey: "idem_10",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.shortfallCents).toBe(4_850);
    // The manager's refund still went through despite the failed claw-back.
    expect(stripe.refunds.create).toHaveBeenCalled();
    const shortfallLine = db._inserts.find(
      (i) => i.table === "vendor_banking_ledger_entries" && (i.row.description as string).includes("shortfall"),
    );
    expect(shortfallLine?.row.amount_cents).toBe(-4_850);
  });
});
