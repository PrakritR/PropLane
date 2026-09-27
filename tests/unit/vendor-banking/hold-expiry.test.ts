import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: vi.fn().mockResolvedValue({ ok: true, recipientCount: 1 }),
}));

import { expireVendorHolds, listExpiredVendorHolds, HOLD_EXPIRY_DAYS } from "@/lib/vendor-banking/hold-expiry.server";

type Row = Record<string, unknown>;

/** Minimal fake Supabase client covering exactly the calls hold-expiry.server.ts makes. */
function makeDb(opts: {
  holds: Row[];
  workOrders?: Row[];
  invoices?: Row[];
  ledgerEntries?: Row[];
  profiles?: Row[];
}) {
  const updates: Row[] = [];
  const inserts: Row[] = [];
  return {
    _updates: updates,
    _inserts: inserts,
    from(table: string) {
      if (table === "platform_payment_holds") {
        return {
          select() {
            return this;
          },
          eq(_c: string, _v: unknown) {
            return this;
          },
          lt(_c: string, _v: unknown) {
            return this;
          },
          update(row: Row) {
            updates.push({ table, row });
            return {
              eq() {
                return this;
              },
              then(resolve: (v: { data: null; error: null }) => unknown) {
                for (const h of opts.holds) Object.assign(h, row);
                return Promise.resolve(resolve({ data: null, error: null }));
              },
            };
          },
          then(resolve: (v: { data: Row[]; error: null }) => unknown) {
            return Promise.resolve(resolve({ data: opts.holds, error: null }));
          },
        };
      }
      if (table === "portal_work_order_records") {
        return {
          select() {
            return this;
          },
          eq(_c: string, v: unknown) {
            this._id = v;
            return this;
          },
          maybeSingle() {
            const found = (opts.workOrders ?? []).find((w) => w.id === this._id);
            return Promise.resolve({ data: found ?? null, error: null });
          },
        } as unknown as Row & { _id?: unknown };
      }
      if (table === "vendor_invoices") {
        return {
          select() {
            return this;
          },
          eq(_c: string, v: unknown) {
            this._id = v;
            return this;
          },
          maybeSingle() {
            const found = (opts.invoices ?? []).find((w) => w.id === this._id);
            return Promise.resolve({ data: found ?? null, error: null });
          },
        } as unknown as Row & { _id?: unknown };
      }
      if (table === "vendor_banking_ledger_entries") {
        return {
          select() {
            return this;
          },
          eq(col: string, v: unknown) {
            (this._filters ??= []).push([col, v]);
            return this;
          },
          in(col: string, values: unknown[]) {
            (this._filters ??= []).push([col, values]);
            return this;
          },
          insert(row: Row) {
            inserts.push({ table, row });
            (opts.ledgerEntries ??= []).push(row);
            return {
              select() {
                return { maybeSingle: () => Promise.resolve({ data: { id: "led_1" }, error: null }) };
              },
            };
          },
          then(resolve: (v: { data: Row[]; error: null }) => unknown) {
            const filters = (this._filters ?? []) as Array<[string, unknown]>;
            const rows = (opts.ledgerEntries ?? []).filter((row) =>
              filters.every(([c, v]) => (Array.isArray(v) ? v.includes(row[c]) : row[c] === v)),
            );
            return Promise.resolve(resolve({ data: rows, error: null }));
          },
        } as unknown as Row & { _filters?: Array<[string, unknown]> };
      }
      if (table === "profiles") {
        return {
          select() {
            return this;
          },
          eq(_c: string, v: unknown) {
            this._id = v;
            return this;
          },
          maybeSingle() {
            const found = (opts.profiles ?? []).find((p) => p.id === this._id);
            return Promise.resolve({ data: found ?? { email: "someone@test.proplane.local" }, error: null });
          },
        } as unknown as Row & { _id?: unknown };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("listExpiredVendorHolds", () => {
  it("only returns held vendor_invoice holds older than 90 days", async () => {
    const db = makeDb({
      holds: [
        { id: "h_old", source: "vendor_invoice", status: "held", created_at: daysAgo(91), owner_user_id: "v1", owner_role: "vendor", amount_cents: 1000, source_id: "wo_1", stripe_charge_id: "ch_1" },
      ],
    });
    const rows = await listExpiredVendorHolds(db as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("h_old");
  });
});

describe("expireVendorHolds", () => {
  const stripe = {
    refunds: { create: vi.fn().mockResolvedValue({ id: "re_1" }) },
  } as unknown as import("stripe").default;

  it(`refunds the ORIGINAL Stripe charge and reverses the exact recorded charge + fee ledger lines for a hold older than ${HOLD_EXPIRY_DAYS} days`, async () => {
    const hold = {
      id: "hold_1",
      source: "vendor_invoice",
      status: "held",
      created_at: daysAgo(91),
      owner_user_id: "vendor_1",
      owner_role: "vendor",
      amount_cents: 9_625, // net credited (gross - fee)
      source_id: "wo_1",
      stripe_charge_id: "ch_abc",
    };
    const db = makeDb({
      holds: [hold],
      workOrders: [{ id: "wo_1", manager_user_id: "manager_1", row_data: { title: "Fix sink" } }],
      ledgerEntries: [
        { vendor_user_id: "vendor_1", source_id: "wo_1", kind: "charge", amount_cents: 10_000 },
        { vendor_user_id: "vendor_1", source_id: "wo_1", kind: "platform_fee", amount_cents: -375 },
      ],
    });

    const result = await expireVendorHolds(stripe, db as never, new Date());
    expect(result).toEqual({ checked: 1, returned: 1, failed: 0, errors: [] });

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { charge: "ch_abc", reason: "requested_by_customer" },
      { idempotencyKey: "hold-expiry:hold_1" },
    );

    const refundLine = db._inserts.find((i) => i.row.kind === "refund");
    expect(refundLine?.row.amount_cents).toBe(-10_000); // exact original gross, reversed
    const feeReversalLine = db._inserts.find((i) => i.row.kind === "adjustment");
    expect(feeReversalLine?.row.amount_cents).toBe(375); // exact original fee, reversed
  });

  it("skips a hold missing its stripe_charge_id and records the failure rather than guessing", async () => {
    const hold = {
      id: "hold_2",
      source: "vendor_invoice",
      status: "held",
      created_at: daysAgo(200),
      owner_user_id: "vendor_1",
      owner_role: "vendor",
      amount_cents: 5_000,
      source_id: "wo_2",
      stripe_charge_id: null,
    };
    const db = makeDb({ holds: [hold] });
    const result = await expireVendorHolds(stripe, db as never, new Date());
    expect(result.checked).toBe(1);
    expect(result.returned).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("no stripe_charge_id");
  });

  it("one hold's failure never blocks the others", async () => {
    const good = {
      id: "hold_good",
      source: "vendor_invoice",
      status: "held",
      created_at: daysAgo(95),
      owner_user_id: "vendor_1",
      owner_role: "vendor",
      amount_cents: 2_000,
      source_id: "wo_3",
      stripe_charge_id: "ch_good",
    };
    const bad = {
      id: "hold_bad",
      source: "vendor_invoice",
      status: "held",
      created_at: daysAgo(95),
      owner_user_id: "vendor_1",
      owner_role: "vendor",
      amount_cents: 3_000,
      source_id: "wo_4",
      stripe_charge_id: null,
    };
    const db = makeDb({
      holds: [bad, good],
      workOrders: [{ id: "wo_3", manager_user_id: "manager_1", row_data: { title: "Fix" } }],
    });
    const result = await expireVendorHolds(stripe, db as never, new Date());
    expect(result.checked).toBe(2);
    expect(result.returned).toBe(1);
    expect(result.failed).toBe(1);
  });
});
