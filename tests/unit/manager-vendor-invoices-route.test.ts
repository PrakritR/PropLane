import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/manager/vendor-invoices — the manager-facing list this Financials'
 * "Pay vendors" card and the Vendors page's per-vendor invoice list read
 * (C042/C081/C260). Scopes strictly to invoices billed to the caller,
 * defaults to the two payable statuses, and narrows to one vendor on request.
 */

type Row = Record<string, unknown>;

function makeFilterableTable(rows: Row[]) {
  function builder(filtered: Row[]) {
    return {
      data: filtered,
      error: null as { message: string } | null,
      select: () => builder(filtered),
      eq: (col: string, val: unknown) => builder(filtered.filter((r) => r[col] === val)),
      in: (col: string, vals: unknown[]) => builder(filtered.filter((r) => vals.includes(r[col]))),
      order: () => builder(filtered),
      range: async (from: number, to: number) => ({ data: filtered.slice(from, to + 1), error: null }),
    };
  }
  return () => builder(rows);
}

const MANAGER_ID = "manager_a";
const OTHER_MANAGER_ID = "manager_b";
const VENDOR_1 = "vendor_1";
const VENDOR_2 = "vendor_2";

function invoiceRow(overrides: Row = {}): Row {
  return {
    id: "inv-1",
    manager_user_id: MANAGER_ID,
    vendor_user_id: VENDOR_1,
    vendor_id: "dir-1",
    work_order_id: null,
    invoice_number: "INV-100",
    line_items: [{ description: "Labor", quantity: 1, unitAmountCents: 13200, amountCents: 13200 }],
    subtotal_cents: 13200,
    tax_cents: 0,
    total_cents: 13200,
    currency: "usd",
    status: "approved",
    memo: null,
    decision_note: null,
    bill_id: null,
    submitted_at: "2026-07-01T00:00:00.000Z",
    decided_at: null,
    paid_at: null,
    paid_from: null,
    created_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const state = vi.hoisted(() => ({
  propertyIds: null as string[] | null,
  auth: null as { db: unknown; userId: string } | null,
}));

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => state.auth,
  assertManagerFinancialsAccess: async () => ({ ok: true }),
}));

vi.mock("@/lib/workspaces/row-scope.server", () => ({
  resolveActiveWorkspaceRowScope: async () => ({ propertyIds: state.propertyIds, includeUntagged: true }),
  rowAllowedInWorkspaceScope: (scope: { propertyIds: string[] | null }, propertyId?: string | null) => scope.propertyIds === null || !propertyId || scope.propertyIds.includes(propertyId),
}));

function makeDb(invoices: Row[], profiles: Row[], work: Row[] = [], payouts: Row[] = []) {
  const vendorInvoices = makeFilterableTable(invoices);
  const profilesTable = makeFilterableTable(profiles);
  return {
    from: (table: string) => {
      if (table === "vendor_invoices") return vendorInvoices();
      if (table === "portal_work_order_records") return makeFilterableTable(work)();
      if (table === "vendor_payouts") return makeFilterableTable(payouts)();
      if (table === "profiles") return profilesTable();
      throw new Error(`unexpected table ${table}`);
    },
  };
}

async function get(url: string) {
  const { GET } = await import("@/app/api/manager/vendor-invoices/route");
  return GET(new Request(url));
}

describe("GET /api/manager/vendor-invoices", () => {
  beforeEach(() => {
    vi.resetModules();
    state.propertyIds = null;
  });

  it("scopes strictly to invoices billed to the caller and defaults to approved+scheduled", async () => {
    const invoices = [
      invoiceRow({ id: "inv-mine-approved", status: "approved" }),
      invoiceRow({ id: "inv-mine-scheduled", status: "scheduled" }),
      invoiceRow({ id: "inv-mine-paid", status: "paid" }),
      invoiceRow({ id: "inv-not-mine", manager_user_id: OTHER_MANAGER_ID }),
    ];
    state.auth = { db: makeDb(invoices, [{ id: VENDOR_1, full_name: "Brightline Plumbing" }]), userId: MANAGER_ID };

    const res = await get("https://example.com/api/manager/vendor-invoices");
    const json = await res.json();
    expect(res.status).toBe(200);
    const ids = (json.invoices as Row[]).map((i) => i.id);
    expect(ids).toEqual(["inv-mine-approved", "inv-mine-scheduled"]);
    expect((json.invoices as Row[])[0]!.vendorName).toBe("Brightline Plumbing");
    expect((json.invoices as Row[])[0]!.vendorUserId).toBe(VENDOR_1);
  });

  it("narrows to one vendor when vendorUserId is given", async () => {
    const invoices = [
      invoiceRow({ id: "inv-v1", vendor_user_id: VENDOR_1 }),
      invoiceRow({ id: "inv-v2", vendor_user_id: VENDOR_2 }),
    ];
    state.auth = {
      db: makeDb(invoices, [
        { id: VENDOR_1, full_name: "Brightline Plumbing" },
        { id: VENDOR_2, full_name: "Ace HVAC" },
      ]),
      userId: MANAGER_ID,
    };

    const res = await get(`https://example.com/api/manager/vendor-invoices?vendorUserId=${VENDOR_2}`);
    const json = await res.json();
    expect((json.invoices as Row[]).map((i) => i.id)).toEqual(["inv-v2"]);
  });

  it("accepts an explicit status filter", async () => {
    const invoices = [
      invoiceRow({ id: "inv-submitted", status: "submitted" }),
      invoiceRow({ id: "inv-approved", status: "approved" }),
    ];
    state.auth = { db: makeDb(invoices, [{ id: VENDOR_1, full_name: "Brightline Plumbing" }]), userId: MANAGER_ID };

    const res = await get("https://example.com/api/manager/vendor-invoices?status=submitted");
    const json = await res.json();
    expect((json.invoices as Row[]).map((i) => i.id)).toEqual(["inv-submitted"]);
  });

  it("paginates exact totals and excludes other-workspace and unassigned service bills", async () => {
    state.propertyIds = ["mine"];
    const invoices = Array.from({ length: 501 }, (_, i) => invoiceRow({ id: `invoice-${i}`, total_cents: 101, work_order_id: "own-service" }));
    invoices.push(invoiceRow({ id: "wrong-workspace", work_order_id: "other-service" }));
    invoices.push(invoiceRow({ id: "unassigned", work_order_id: "unassigned-service" }));
    const work = [
      { id: "own-service", manager_user_id: MANAGER_ID, property_id: "mine", vendor_user_id: VENDOR_1 },
      { id: "other-service", manager_user_id: MANAGER_ID, property_id: "theirs", vendor_user_id: VENDOR_1 },
      { id: "unassigned-service", manager_user_id: MANAGER_ID, property_id: "mine", vendor_user_id: null },
    ];
    state.auth = { db: makeDb(invoices, [], work), userId: MANAGER_ID };
    const res = await get("https://example.com/api/manager/vendor-invoices?outgoing=1");
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.invoices).toHaveLength(501);
    expect(json.totals.owedCents).toBe(50601);
  });

  it("dedupes payouts by invoice identity only and includes separate payouts on the same service", async () => {
    const year = new Date().getUTCFullYear();
    const paidAt = `${year}-01-02T00:00:00Z`;
    const invoices = [invoiceRow({ id: "paid-invoice", status: "paid", paid_at: paidAt, total_cents: 100, work_order_id: "service" })];
    const payout = { manager_user_id: MANAGER_ID, vendor_user_id: VENDOR_1, work_order_id: "service", status: "paid", amount_cents: 100, created_at: paidAt, updated_at: paidAt };
    state.auth = { db: makeDb(invoices, [], [{ id: "service", manager_user_id: MANAGER_ID, property_id: "mine", vendor_user_id: VENDOR_1 }], [
      { ...payout, id: "same", invoice_id: "paid-invoice" },
      { ...payout, id: "different", invoice_id: null },
    ]), userId: MANAGER_ID };
    const res = await get("https://example.com/api/manager/vendor-invoices?outgoing=1&status=paid");
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.payouts.map((row: Row) => row.id)).toEqual(["different"]);
    expect(json.totals.paidThisYearCents).toBe(200);
  });

  it("rejects an unauthenticated caller", async () => {
    state.auth = null;
    const res = await get("https://example.com/api/manager/vendor-invoices");
    expect(res.status).toBe(401);
  });
});
