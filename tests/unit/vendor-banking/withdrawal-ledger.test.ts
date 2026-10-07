import { describe, expect, it } from "vitest";
import { makeFakeDb } from "./_fake-db";
import { recordVendorWithdrawalLedger } from "@/lib/vendor-banking/withdrawal-ledger.server";

const rows = (db: ReturnType<typeof makeFakeDb>) => db._tables.vendor_banking_ledger_entries ?? [];

describe("recordVendorWithdrawalLedger", () => {
  it("a standard withdrawal is one debit for the full amount, no fee line", async () => {
    const db = makeFakeDb();
    await recordVendorWithdrawalLedger(db as never, { vendorUserId: "v1", payoutId: "po_1", amountCents: 40_000, feeCents: 0, method: "standard" });
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ kind: "withdrawal", amount_cents: -40_000, source: "withdrawal", source_id: "po_1", idempotency_key: "withdrawal:po_1:withdrawal" });
  });

  it("an instant withdrawal debits what the bank receives and books the instant fee separately", async () => {
    const db = makeFakeDb();
    await recordVendorWithdrawalLedger(db as never, { vendorUserId: "v1", payoutId: "po_2", amountCents: 20_000, feeCents: 300, method: "instant" });
    expect(rows(db).map((r) => [r.kind, r.amount_cents, r.idempotency_key])).toEqual([
      ["withdrawal", -19_700, "withdrawal:po_2:withdrawal"],
      ["platform_fee", -300, "withdrawal:po_2:instant_fee"],
    ]);
    expect(rows(db).reduce((sum, r) => sum + Number(r.amount_cents), 0)).toBe(-20_000);
  });

  it("a fee on a standard payout is ignored (Standard is free)", async () => {
    const db = makeFakeDb();
    await recordVendorWithdrawalLedger(db as never, { vendorUserId: "v1", payoutId: "po_3", amountCents: 1_000, feeCents: 50, method: "standard" });
    expect(rows(db).map((r) => r.amount_cents)).toEqual([-1_000]);
  });
});
