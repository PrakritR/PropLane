import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordVendorServiceFeeRevenue,
  recordVendorServiceFeeRevenueReversal,
} from "@/lib/vendor-banking/platform-revenue.server";

type InsertResult = { error: { code?: string; message: string } | null };

/** Minimal fake: records inserts and enforces the idempotency_key unique constraint like the real table. */
function makeDb(opts: { failWith?: { code?: string; message: string }; throwOnFrom?: boolean } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  return {
    _rows: rows,
    from(table: string) {
      if (opts.throwOnFrom) throw new Error(`relation "${table}" does not exist`);
      return {
        insert(row: Record<string, unknown>): Promise<InsertResult> {
          if (table !== "platform_revenue_entries") throw new Error(`unexpected table ${table}`);
          if (opts.failWith) return Promise.resolve({ error: opts.failWith });
          if (rows.some((r) => r.idempotency_key === row.idempotency_key)) {
            return Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
          }
          rows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const base = { vendorUserId: "vendor_1", managerUserId: "manager_1", source: "invoice" as const, sourceId: "inv_1" };

describe("recordVendorServiceFeeRevenue", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  it("books the fee as positive platform revenue keyed on source + id", async () => {
    const db = makeDb();
    const result = await recordVendorServiceFeeRevenue(db as never, { ...base, feeCents: 300 });
    expect(result).toEqual({ ok: true, recorded: true });
    expect(db._rows).toEqual([
      {
        kind: "vendor_service_fee",
        amount_cents: 300,
        vendor_user_id: "vendor_1",
        manager_user_id: "manager_1",
        source: "invoice",
        source_id: "inv_1",
        idempotency_key: "vendor_service_fee:invoice:inv_1",
        description: "PropLane service fee (3%)",
      },
    ]);
  });

  it("is idempotent: a redelivered settlement books nothing twice and still succeeds", async () => {
    const db = makeDb();
    await recordVendorServiceFeeRevenue(db as never, { ...base, feeCents: 300 });
    const again = await recordVendorServiceFeeRevenue(db as never, { ...base, feeCents: 300 });
    expect(again).toEqual({ ok: true, recorded: false });
    expect(db._rows).toHaveLength(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("a work order and an invoice with the same id are separate keys", async () => {
    const db = makeDb();
    await recordVendorServiceFeeRevenue(db as never, { ...base, source: "work_order", feeCents: 300 });
    await recordVendorServiceFeeRevenue(db as never, { ...base, source: "invoice", feeCents: 300 });
    expect(db._rows.map((r) => r.idempotency_key)).toEqual([
      "vendor_service_fee:work_order:inv_1",
      "vendor_service_fee:invoice:inv_1",
    ]);
  });

  it("fee 0 (or negative / NaN) writes nothing", async () => {
    const db = makeDb();
    for (const feeCents of [0, -5, Number.NaN]) {
      expect(await recordVendorServiceFeeRevenue(db as never, { ...base, feeCents })).toEqual({ ok: true, recorded: false });
    }
    expect(db._rows).toEqual([]);
  });

  it("a flag-off checkout freezes fee 0, so nothing is booked", async () => {
    const db = makeDb();
    // The flag decides whether a fee is ever taken (vendorPayFeeCents -> 0); the settle site passes that frozen 0.
    const prior = process.env.VENDOR_BANKING_ENABLED;
    process.env.VENDOR_BANKING_ENABLED = "0";
    try {
      const { vendorPayFeeCents } = await import("@/lib/platform-fees");
      const frozenFee = vendorPayFeeCents(10_000);
      expect(frozenFee).toBe(0);
      await recordVendorServiceFeeRevenue(db as never, { ...base, feeCents: frozenFee });
    } finally {
      if (prior === undefined) delete process.env.VENDOR_BANKING_ENABLED;
      else process.env.VENDOR_BANKING_ENABLED = prior;
    }
    expect(db._rows).toEqual([]);
  });

  it("never throws into the payment path: a non-unique DB error returns ok:false and logs", async () => {
    const db = makeDb({ failWith: { code: "42P01", message: 'relation "platform_revenue_entries" does not exist' } });
    const result = await recordVendorServiceFeeRevenue(db as never, { ...base, feeCents: 300 });
    expect(result).toEqual({ ok: false });
    expect(errSpy).toHaveBeenCalledOnce();
  });

  it("never throws even when the client itself throws", async () => {
    const db = makeDb({ throwOnFrom: true });
    await expect(recordVendorServiceFeeRevenue(db as never, { ...base, feeCents: 300 })).resolves.toEqual({ ok: false });
    expect(errSpy).toHaveBeenCalledOnce();
  });
});

describe("recordVendorServiceFeeRevenueReversal", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  const rev = { vendorUserId: "vendor_1", managerUserId: "manager_1", source: "refund" as const, sourceId: "payout_1" };

  it("books a NEGATIVE entry keyed on the refund id", async () => {
    const db = makeDb();
    const result = await recordVendorServiceFeeRevenueReversal(db as never, { ...rev, feeCents: 120, reversalId: "idem_2" });
    expect(result).toEqual({ ok: true, recorded: true });
    expect(db._rows[0]).toMatchObject({
      kind: "vendor_service_fee_reversal",
      amount_cents: -120,
      source: "refund",
      source_id: "payout_1",
      idempotency_key: "vendor_service_fee_reversal:refund:idem_2",
    });
  });

  it("two partial refunds of one payment are two entries; a retried one is a no-op", async () => {
    const db = makeDb();
    await recordVendorServiceFeeRevenueReversal(db as never, { ...rev, feeCents: 120, reversalId: "idem_a" });
    await recordVendorServiceFeeRevenueReversal(db as never, { ...rev, feeCents: 60, reversalId: "idem_b" });
    const retry = await recordVendorServiceFeeRevenueReversal(db as never, { ...rev, feeCents: 120, reversalId: "idem_a" });
    expect(retry).toEqual({ ok: true, recorded: false });
    expect(db._rows.map((r) => r.amount_cents)).toEqual([-120, -60]);
  });

  it("hold expiry reverses against the hold id", async () => {
    const db = makeDb();
    await recordVendorServiceFeeRevenueReversal(db as never, { ...rev, source: "hold_expiry", sourceId: "wo_1", feeCents: 375, reversalId: "hold_1" });
    expect(db._rows[0]).toMatchObject({ amount_cents: -375, idempotency_key: "vendor_service_fee_reversal:hold_expiry:hold_1" });
  });

  it("fee 0 writes nothing, and a failure never throws", async () => {
    const db = makeDb();
    expect(await recordVendorServiceFeeRevenueReversal(db as never, { ...rev, feeCents: 0, reversalId: "x" })).toEqual({ ok: true, recorded: false });
    expect(db._rows).toEqual([]);
    const broken = makeDb({ failWith: { message: "connection reset" } });
    await expect(recordVendorServiceFeeRevenueReversal(broken as never, { ...rev, feeCents: 5, reversalId: "y" })).resolves.toEqual({ ok: false });
  });
});
