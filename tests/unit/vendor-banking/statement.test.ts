import { describe, expect, it } from "vitest";
import { makeFakeDb } from "./_fake-db";
import { buildVendorStatement, vendorStatementCsv } from "@/lib/vendor-banking/statement.server";

function entry(overrides: Partial<Record<string, unknown>>) {
  return {
    id: `e_${Math.random()}`,
    vendor_user_id: "vendor_1",
    manager_user_id: "manager_1",
    kind: "charge",
    amount_cents: 0,
    source: "work_order",
    source_id: "wo_1",
    description: "desc",
    stripe_object_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildVendorStatement — running balance", () => {
  it("accumulates in chronological order and includes the reconciliation stamp", async () => {
    const db = makeFakeDb({
      vendor_banking_ledger_entries: [
        entry({ kind: "charge", amount_cents: 10_000, created_at: "2026-09-01T00:00:00.000Z" }),
        entry({ kind: "platform_fee", amount_cents: -300, created_at: "2026-09-01T00:00:01.000Z" }),
        entry({ kind: "withdrawal", amount_cents: -5_000, created_at: "2026-09-05T00:00:00.000Z" }),
      ],
      vendor_banking_reconciliation: [
        { vendor_user_id: "vendor_1", reconciled_at: "2026-09-06T00:00:00.000Z", matches: true, ledger_total_cents: 4_700, stripe_total_cents: 4_700 },
      ],
    });
    const statement = await buildVendorStatement(db as never, "vendor_1", {});
    expect(statement.lines.map((l) => l.runningBalanceCents)).toEqual([10_000, 9_700, 4_700]);
    expect(statement.reconciliation).toEqual({
      reconciledAt: "2026-09-06T00:00:00.000Z",
      matches: true,
      ledgerTotalCents: 4_700,
      stripeTotalCents: 4_700,
    });
  });

  it("with no reconciliation row yet, reconciliation is null (never a fabricated stamp)", async () => {
    const db = makeFakeDb({ vendor_banking_ledger_entries: [entry({ amount_cents: 500 })] });
    const statement = await buildVendorStatement(db as never, "vendor_1", {});
    expect(statement.reconciliation).toBeNull();
  });
});

describe("vendorStatementCsv", () => {
  it("renders one row per line with a header, quoting descriptions", async () => {
    const csv = vendorStatementCsv({
      lines: [
        {
          id: "e1",
          vendorUserId: "vendor_1",
          managerUserId: null,
          kind: "charge",
          amountCents: 10_000,
          source: "work_order",
          sourceId: "wo_1",
          description: 'Fix "sink"',
          stripeObjectId: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          runningBalanceCents: 10_000,
        },
      ],
      reconciliation: null,
    });
    const rows = csv.split("\n");
    expect(rows[0]).toBe('"Date","Type","Description","Amount","Running balance"');
    expect(rows[1]).toBe('"2026-09-01T00:00:00.000Z","Charge","Fix ""sink""","100.00","100.00"');
  });
});
