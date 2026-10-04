import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/manager/vendor-invoices?vendorId=<roster record id> — the vendor
 * record's Outgoing payments tab. A manager pays vendors whether or not they
 * have signed up, so the payee is the roster RECORD: a bill matches by the
 * record id it was filed under, or by the record's linked login, de-duplicated,
 * and always inside the signed-in manager's own rows.
 */

type Row = Record<string, unknown>;

function table(rows: Row[]) {
  function builder(filtered: Row[]) {
    return {
      select: () => builder(filtered),
      eq: (col: string, val: unknown) => builder(filtered.filter((r) => r[col] === val)),
      in: (col: string, vals: unknown[]) => builder(filtered.filter((r) => vals.includes(r[col]))),
      order: () => builder(filtered),
      range: async (from: number, to: number) => ({ data: filtered.slice(from, to + 1), error: null }),
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
    };
  }
  return builder(rows);
}

const MANAGER = "manager_a";
const OTHER = "manager_b";

function invoice(overrides: Row = {}): Row {
  return {
    id: "inv-1",
    manager_user_id: MANAGER,
    vendor_user_id: "vendor-login-1",
    vendor_id: "record-1",
    work_order_id: null,
    invoice_number: "INV-1",
    line_items: [],
    subtotal_cents: 5000,
    tax_cents: 0,
    total_cents: 5000,
    currency: "usd",
    status: "approved",
    memo: null,
    decision_note: null,
    bill_id: null,
    submitted_at: "2026-09-01T00:00:00.000Z",
    decided_at: null,
    paid_at: null,
    paid_from: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const state = vi.hoisted(() => ({ auth: null as { db: unknown; userId: string } | null }));

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => state.auth,
  assertManagerFinancialsAccess: async () => ({ ok: true }),
}));
vi.mock("@/lib/workspaces/row-scope.server", () => ({
  resolveActiveWorkspaceRowScope: async () => ({ propertyIds: null, includeUntagged: true }),
  rowAllowedInWorkspaceScope: () => true,
}));

function makeDb(opts: { records: Row[]; invoices: Row[]; payouts?: Row[]; profiles?: Row[]; work?: Row[] }) {
  return {
    from: (name: string) => {
      if (name === "manager_vendor_records") return table(opts.records);
      if (name === "vendor_invoices") return table(opts.invoices);
      if (name === "vendor_payouts") return table(opts.payouts ?? []);
      if (name === "profiles") return table(opts.profiles ?? []);
      if (name === "portal_work_order_records") return table(opts.work ?? []);
      throw new Error(`unexpected table ${name}`);
    },
  };
}

async function get(query: string) {
  const { GET } = await import("@/app/api/manager/vendor-invoices/route");
  return GET(new Request(`https://example.com/api/manager/vendor-invoices?${query}`));
}

describe("vendor record payments", () => {
  beforeEach(() => vi.resetModules());

  it("lists paid, scheduled and to-pay bills of a vendor record with no linked login", async () => {
    state.auth = {
      userId: MANAGER,
      db: makeDb({
        records: [{ id: "record-1", manager_user_id: MANAGER, vendor_user_id: null }],
        invoices: [
          invoice({ id: "to-pay", status: "approved", work_order_id: "wo-1" }),
          invoice({ id: "scheduled", status: "scheduled", scheduled_for: "2099-01-01", work_order_id: "wo-1" }),
          invoice({ id: "paid", status: "paid", paid_at: "2026-09-02T00:00:00.000Z" }),
          invoice({ id: "other-record", vendor_id: "record-2", vendor_user_id: "vendor-login-2", work_order_id: "wo-1" }),
        ],
        work: [{ id: "wo-1", manager_user_id: MANAGER, vendor_user_id: "vendor-login-1", property_id: null, row_data: { title: "Fix sink" } }],
      }),
    };
    const json = await (await get("vendorId=record-1&outgoing=1&status=approved,scheduled,paid")).json();
    expect((json.invoices as Row[]).map((i) => i.id).sort()).toEqual(["paid", "scheduled", "to-pay"]);
  });

  it("adds the linked login's bills and de-duplicates a bill matched both ways", async () => {
    state.auth = {
      userId: MANAGER,
      db: makeDb({
        records: [{ id: "record-1", manager_user_id: MANAGER, vendor_user_id: "vendor-login-1" }],
        invoices: [
          invoice({ id: "both", status: "paid" }),
          invoice({ id: "login-only", vendor_id: "record-elsewhere", status: "paid" }),
          invoice({ id: "someone-else", vendor_user_id: "vendor-login-9", vendor_id: "record-9", status: "paid" }),
        ],
      }),
    };
    const json = await (await get("vendorId=record-1&outgoing=1&status=paid")).json();
    expect((json.invoices as Row[]).map((i) => i.id).sort()).toEqual(["both", "login-only"]);
  });

  it("stays inside the manager: a record owned by someone else is a 404 and shows nothing", async () => {
    state.auth = {
      userId: MANAGER,
      db: makeDb({
        records: [{ id: "record-x", manager_user_id: OTHER, vendor_user_id: "vendor-login-1" }],
        invoices: [invoice({ id: "theirs", manager_user_id: OTHER, vendor_id: "record-x", status: "paid" })],
      }),
    };
    const res = await get("vendorId=record-x&outgoing=1&status=paid");
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("theirs");
  });

  it("never returns another manager's bill for the same record id", async () => {
    state.auth = {
      userId: MANAGER,
      db: makeDb({
        records: [{ id: "record-1", manager_user_id: MANAGER, vendor_user_id: null }],
        invoices: [
          invoice({ id: "mine", status: "paid" }),
          invoice({ id: "not-mine", manager_user_id: OTHER, status: "paid" }),
        ],
      }),
    };
    const json = await (await get("vendorId=record-1&outgoing=1&status=paid")).json();
    expect((json.invoices as Row[]).map((i) => i.id)).toEqual(["mine"]);
  });

  it("returns payouts to the record's login only, and none for a record with no login", async () => {
    const payouts = [
      { id: "p-1", manager_user_id: MANAGER, vendor_user_id: "vendor-login-1", work_order_id: null, invoice_id: "none", amount_cents: 900, status: "paid", created_at: "2026-09-03T00:00:00.000Z", updated_at: null },
      { id: "p-2", manager_user_id: MANAGER, vendor_user_id: "vendor-login-9", work_order_id: null, invoice_id: "none", amount_cents: 700, status: "paid", created_at: "2026-09-03T00:00:00.000Z", updated_at: null },
    ];
    state.auth = {
      userId: MANAGER,
      db: makeDb({ records: [{ id: "record-1", manager_user_id: MANAGER, vendor_user_id: "vendor-login-1" }], invoices: [], payouts, profiles: [{ id: "vendor-login-1", full_name: "Pacific Plumbing" }] }),
    };
    const withLogin = await (await get("vendorId=record-1&outgoing=1&status=approved,scheduled,paid")).json();
    expect((withLogin.payouts as Row[]).map((p) => p.id)).toEqual(["p-1"]);

    state.auth = {
      userId: MANAGER,
      db: makeDb({ records: [{ id: "record-1", manager_user_id: MANAGER, vendor_user_id: null }], invoices: [], payouts }),
    };
    vi.resetModules();
    const noLogin = await (await get("vendorId=record-1&outgoing=1&status=approved,scheduled,paid")).json();
    expect(noLogin.payouts).toEqual([]);
  });
});
