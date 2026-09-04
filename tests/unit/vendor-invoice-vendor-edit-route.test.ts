import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PRP-254 #3 — a vendor may correct or withdraw an invoice the manager has not reviewed.
 *
 * The vendor is SELECT-only on `vendor_invoices` at the database layer, deliberately: a public
 * client that could UPDATE the row could flip `status` or `total_cents`. That also left no way
 * to fix a typo — the vendor had to ask the manager to reject the invoice and send a duplicate.
 * These handlers are the authorized path, and the rules they must not lose are:
 * only your own invoice, only while nobody has reviewed it, and totals recomputed here.
 */

type Row = Record<string, unknown>;

function makeFakeDb(rows: Row[]) {
  function builder(table: string) {
    const filters: [string, unknown][] = [];
    let mode: "select" | "update" | "delete" = "select";
    let patch: Row | null = null;

    const matched = () =>
      rows.filter((r) => r.__table === table && filters.every(([col, val]) => r[col] === val));

    const api = {
      select() {
        return api;
      },
      update(vals: Row) {
        mode = "update";
        patch = vals;
        return api;
      },
      delete() {
        mode = "delete";
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return api;
      },
      maybeSingle() {
        const hit = matched()[0] ?? null;
        if (mode === "update" && hit && patch) Object.assign(hit, patch);
        if (mode === "delete" && hit) rows.splice(rows.indexOf(hit), 1);
        return Promise.resolve({ data: hit ? { ...hit } : null, error: null });
      },
    };
    return api;
  }
  return { from: builder };
}

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  rows: [] as Row[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeFakeDb(state.rows),
}));

const VENDOR = "vendor-1";
const OTHER_VENDOR = "vendor-2";
const INVOICE = "inv-1";

function seed(over: Row = {}) {
  state.rows = [
    { __table: "profiles", id: VENDOR, role: "vendor" },
    {
      __table: "vendor_invoices",
      id: INVOICE,
      vendor_user_id: VENDOR,
      vendor_id: "dir-1",
      status: "submitted",
      bill_id: null,
      invoice_number: "INV-1",
      line_items: [{ description: "Labor", quantity: 1, unitAmountCents: 10000, amountCents: 10000 }],
      subtotal_cents: 10000,
      tax_cents: 0,
      total_cents: 10000,
      currency: "usd",
      memo: null,
      decision_note: null,
      work_order_id: null,
      submitted_at: "2026-09-01T00:00:00Z",
      decided_at: null,
      paid_at: null,
      created_at: "2026-09-01T00:00:00Z",
      ...over,
    },
  ];
}

async function patch(body: unknown, id = INVOICE) {
  const { PATCH } = await import("@/app/api/vendor/invoices/[id]/route");
  return PATCH(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
}

async function del(id = INVOICE) {
  const { DELETE } = await import("@/app/api/vendor/invoices/[id]/route");
  return DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

function invoiceRow(): Row | undefined {
  return state.rows.find((r) => r.__table === "vendor_invoices");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: VENDOR };
  seed();
});

describe("vendor invoice correction", () => {
  it("lets the vendor fix a line item while the invoice is unreviewed", async () => {
    const res = await patch({
      lineItems: [{ description: "Labor", quantity: 2, unitAmountCents: 10000 }],
    });

    expect(res.status).toBe(200);
    expect(invoiceRow()?.total_cents).toBe(20000);
  });

  it("recomputes the total from the line items instead of trusting one", async () => {
    await patch({
      lineItems: [{ description: "Labor", quantity: 1, unitAmountCents: 5000 }],
      // A client-supplied total must not survive.
      totalCents: 999999,
      subtotalCents: 999999,
    });

    expect(invoiceRow()?.total_cents).toBe(5000);
    expect(invoiceRow()?.subtotal_cents).toBe(5000);
  });

  it("adds tax to the recomputed subtotal", async () => {
    await patch({
      lineItems: [{ description: "Labor", quantity: 1, unitAmountCents: 10000 }],
      taxCents: 875,
    });

    expect(invoiceRow()?.total_cents).toBe(10875);
  });

  it("refuses an edit once the manager has approved it", async () => {
    seed({ status: "approved" });

    const res = await patch({ memo: "oops" });

    expect(res.status).toBe(409);
    expect(invoiceRow()?.memo).toBeNull();
  });

  it("refuses an edit to an invoice already carrying a manager bill", async () => {
    seed({ bill_id: "bill-9" });

    expect((await patch({ memo: "oops" })).status).toBe(409);
  });

  it("refuses an empty line-item list rather than writing a zero invoice", async () => {
    const res = await patch({ lineItems: [] });

    expect(res.status).toBe(400);
    expect(invoiceRow()?.total_cents).toBe(10000);
  });

  it("reads another vendor's invoice as missing, not forbidden", async () => {
    state.user = { id: OTHER_VENDOR };
    state.rows.push({ __table: "profiles", id: OTHER_VENDOR, role: "vendor" });

    const res = await patch({ memo: "not mine" });

    expect(res.status).toBe(404);
    expect(invoiceRow()?.memo).toBeNull();
  });

  it("refuses a non-vendor caller", async () => {
    state.rows = state.rows.map((r) => (r.__table === "profiles" ? { ...r, role: "manager" } : r));

    expect((await patch({ memo: "x" })).status).toBe(403);
  });
});

describe("vendor invoice withdrawal", () => {
  it("withdraws an unreviewed invoice", async () => {
    const res = await del();

    expect(res.status).toBe(200);
    expect(invoiceRow()).toBeUndefined();
  });

  it("refuses to withdraw one the manager already approved", async () => {
    seed({ status: "approved" });

    expect((await del()).status).toBe(409);
    expect(invoiceRow()).toBeDefined();
  });

  it("refuses to withdraw another vendor's invoice", async () => {
    state.user = { id: OTHER_VENDOR };
    state.rows.push({ __table: "profiles", id: OTHER_VENDOR, role: "vendor" });

    expect((await del()).status).toBe(404);
    expect(invoiceRow()).toBeDefined();
  });
});
