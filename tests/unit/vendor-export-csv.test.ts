import { beforeEach, describe, expect, it, vi } from "vitest";
import { csvMoneyFromCents, escapeCsv, toCsv } from "@/lib/csv";

/**
 * PRP-254 #4 — CSV export of a vendor's invoices and payouts.
 *
 * A 1099 contractor needs their year's figures every January; until this existed the answer
 * was to screenshot a web page. Both datasets are scoped to the signed-in vendor, and neither
 * takes an id or an owner from the request.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  role: "vendor",
  invoices: [] as Row[],
  payouts: [] as Row[],
  filters: [] as string[],
}));

function table(rows: Row[]) {
  const api = {
    select: () => api,
    order: () => api,
    eq: (col: string, val: unknown) => {
      state.filters.push(`eq:${col}=${String(val)}`);
      return api;
    },
    gte: (col: string, val: unknown) => {
      state.filters.push(`gte:${col}=${String(val)}`);
      return api;
    },
    lte: (col: string, val: unknown) => {
      state.filters.push(`lte:${col}=${String(val)}`);
      return api;
    },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
  };
  return api;
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (name: string) => {
      if (name === "profiles") return table([{ role: state.role }]);
      if (name === "vendor_invoices") return table(state.invoices);
      return table(state.payouts);
    },
  }),
}));

async function get(query: string) {
  const { GET } = await import("@/app/api/vendor/export/route");
  return GET(new Request(`http://localhost/api/vendor/export${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: "vendor-1" };
  state.role = "vendor";
  state.filters = [];
  state.invoices = [
    {
      id: "inv-1",
      vendor_id: "dir-1",
      work_order_id: "wo-1",
      invoice_number: "INV-1",
      line_items: [],
      subtotal_cents: 10000,
      tax_cents: 875,
      total_cents: 10875,
      currency: "usd",
      status: "paid",
      memo: "Fixed the sink, then the, comma",
      decision_note: null,
      bill_id: null,
      submitted_at: "2026-01-05T00:00:00Z",
      decided_at: "2026-01-06T00:00:00Z",
      paid_at: "2026-01-07T00:00:00Z",
      created_at: "2026-01-05T00:00:00Z",
    },
  ];
  state.payouts = [
    {
      id: "p-1",
      work_order_id: "wo-1",
      amount_cents: 10875,
      stripe_transfer_id: "tr_1",
      status: "paid",
      failure_reason: null,
      created_at: "2026-01-07T00:00:00Z",
    },
  ];
});

describe("vendor CSV export", () => {
  it("exports invoices as money, not cents", async () => {
    const res = await get("?dataset=invoices");
    const body = await res.text();

    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(body.split("\n")[0]).toContain("Total");
    expect(body).toContain("108.75");
    expect(body).not.toContain("10875");
  });

  it("quotes a field containing a comma so the row does not split", async () => {
    const body = await (await get("?dataset=invoices")).text();

    expect(body).toContain('"Fixed the sink, then the, comma"');
    // Header + exactly one data row.
    expect(body.split("\n")).toHaveLength(2);
  });

  it("writes an empty cell for a missing value rather than the text null", async () => {
    const body = await (await get("?dataset=payouts")).text();

    expect(body).not.toContain("null");
  });

  it("scopes both datasets to the signed-in vendor", async () => {
    await get("?dataset=invoices");
    expect(state.filters).toContain("eq:vendor_user_id=vendor-1");

    state.filters = [];
    await get("?dataset=payouts");
    expect(state.filters).toContain("eq:vendor_user_id=vendor-1");
  });

  it("applies a date range when given one", async () => {
    await get("?dataset=payouts&from=2026-01-01&to=2026-12-31");

    expect(state.filters).toContain("gte:created_at=2026-01-01");
    expect(state.filters).toContain("lte:created_at=2026-12-31");
  });

  it("ignores an unparseable bound instead of narrowing the range", async () => {
    await get("?dataset=payouts&from=last%20january");

    expect(state.filters.some((f) => f.startsWith("gte:"))).toBe(false);
  });

  it("names the download so a January filing is filed under the right year", async () => {
    const res = await get("?dataset=payouts");

    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="proplane-payouts-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it("refuses an unknown dataset rather than defaulting to one", async () => {
    expect((await get("?dataset=everything")).status).toBe(400);
  });

  it("refuses a non-vendor caller", async () => {
    state.role = "manager";
    expect((await get("?dataset=invoices")).status).toBe(403);
  });

  it("refuses an anonymous caller", async () => {
    state.user = null;
    expect((await get("?dataset=invoices")).status).toBe(401);
  });
});

describe("shared CSV writer", () => {
  it("doubles an inner quote", () => {
    expect(escapeCsv('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("leaves an ordinary value unquoted", () => {
    expect(escapeCsv("plain")).toBe("plain");
  });

  it("renders cents as a plain decimal with no symbol or separator", () => {
    expect(csvMoneyFromCents(123456789)).toBe("1234567.89");
    expect(csvMoneyFromCents(0)).toBe("0.00");
  });

  it("writes an empty field for null and undefined", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\n,");
  });
});
