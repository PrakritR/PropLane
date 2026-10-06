import { describe, expect, it } from "vitest";
import { existingClassifiedSpendParts, selectClassifiedSpendParts } from "@/lib/platform-balance-spend.server";

type Row = Record<string, unknown>;
function dbFor(tables: Record<string, Row[]>) {
  return { from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const sets: Array<[string, readonly unknown[]]> = [];
    let max = 1000;
    const rows = () => (tables[table] ?? []).filter((row) =>
      filters.every(([key, value]) => row[key] === value) &&
      sets.every(([key, values]) => values.includes(row[key]))).slice(0, max);
    const query = {
      select: () => query, eq: (key: string, value: unknown) => {
        filters.push([key, value]); return query;
      }, in: (key: string, values: readonly unknown[]) => {
        sets.push([key, values]); return query;
      }, order: () => query, limit: (size: number) => { max = size; return query; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (done: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve(done({ data: rows(), error: null })),
    };
    return query;
  } };
}

const hold = { id: "hold-income", owner_user_id: "manager", owner_role: "manager",
  status: "classified_held", source_verified_at: "2026-10-04T00:00:00Z",
  source_allocation_mode: "hold", stripe_charge_id: "ch_income", amount_cents: 100,
  source_components: [{ source_id: "rent", liability_class: "income", recipient_net_cents: 100 }] };
const mirror = { account_id: "wallet-manager", kind: "resident_payment", status: "available",
  source_liability_class: "income", source_hold_id: "hold-income",
  source_component_id: "rent", amount_cents: 100, stripe_object_id: "ch_income",
  available_on: "2026-10-04T00:00:00Z" };

describe("classified balance spend proposal", () => {
  it("uses only cleared captured income and excludes deposit and offline cash", async () => {
    const db = dbFor({ proplane_balance_entries: [mirror,
      { ...mirror, source_liability_class: "deposit", source_component_id: "deposit", amount_cents: 50 },
      { ...mirror, kind: "adjustment", source_hold_id: null, amount_cents: 1 }],
      platform_payment_holds: [hold] });
    expect(await selectClassifiedSpendParts(db as never, "wallet-manager", "manager", 100))
      .toEqual({ parts: [{ hold_id: "hold-income", source_id: "rent", source_net_cents: 100 }],
        eligibleCents: 100 });
    expect((await selectClassifiedSpendParts(db as never, "wallet-manager", "manager", 101)).eligibleCents)
      .toBe(100);
  });

  it("subtracts exact refunds and settled spend, and skips unresolved reservations", async () => {
    const tables = { proplane_balance_entries: [mirror], platform_payment_holds: [hold],
      platform_hold_refund_attempts: [{ hold_id: "hold-income", status: "succeeded",
        recipient_debit_components: [{ source_id: "rent", recipient_debit_cents: 20 }] }],
      platform_source_consumption_legs: [{ hold_id: "hold-income", source_component_id: "rent",
        status: "settled", source_net_cents: 30 }] };
    expect(await selectClassifiedSpendParts(dbFor(tables) as never, "wallet-manager", "manager", 80))
      .toEqual({ parts: [{ hold_id: "hold-income", source_id: "rent", source_net_cents: 50 }],
        eligibleCents: 50 });
    tables.platform_source_consumption_legs.push({ hold_id: "hold-income", source_component_id: "rent",
      status: "reserved", source_net_cents: 1 });
    expect((await selectClassifiedSpendParts(dbFor(tables) as never, "wallet-manager", "manager", 1)).parts)
      .toEqual([]);
  });

  it("reuses the original vector for a same-key replay after the source is spent", async () => {
    const vector = [{ hold_id: "hold-income", source_id: "rent", source_net_cents: 100 }];
    const db = dbFor({ proplane_balance_entries: [{ account_id: "wallet-manager",
      idempotency_key: "vendor-invoice:one:out", amount_cents: -100,
      kind: "vendor_payment_out", status: "available", source_spend_breakdown: vector }] });
    expect(await existingClassifiedSpendParts(db as never, "wallet-manager", "vendor-invoice:one", 100))
      .toEqual(vector);
    await expect(existingClassifiedSpendParts(db as never, "wallet-manager", "vendor-invoice:one", 99))
      .rejects.toThrow(/claimed payment/);
  });
});
