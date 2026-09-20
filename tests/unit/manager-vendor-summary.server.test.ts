import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { linkedOwnerScopeForModule } = vi.hoisted(() => ({ linkedOwnerScopeForModule: vi.fn() }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule }));

import { loadManagerVendorSummary } from "@/lib/manager-vendor-summary.server";

type Row = Record<string, unknown>;
type Op = [string, string, unknown];

function fakeDb(tables: Record<string, Row[]>) {
  const calls: Array<{ table: string; ops: Op[] }> = [];
  const matches = (row: Row, [kind, key, value]: Op) => {
    const actual = row[key];
    if (kind === "eq") return actual === value;
    if (kind === "in") return (value as unknown[]).includes(actual);
    if (kind === "contains") return Object.entries(value as Row).every(([nestedKey, nestedValue]) => {
      const candidate = (row[key] ?? {}) as Row;
      return typeof nestedValue === "object" && nestedValue !== null
        ? Object.entries(nestedValue as Row).every(([k, v]) => (candidate[nestedKey] as Row | undefined)?.[k] === v)
        : candidate[nestedKey] === nestedValue;
    });
    return true;
  };
  const from = (table: string) => {
    const ops: Op[] = [];
    let maximum: number | null = null;
    let range: [number, number] | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (key: string, value: unknown) => { ops.push(["eq", key, value]); return chain; },
      in: (key: string, value: unknown) => { ops.push(["in", key, value]); return chain; },
      contains: (key: string, value: unknown) => { ops.push(["contains", key, value]); return chain; },
      order: () => chain,
      limit: (value: number) => { maximum = value; return chain; },
      range: (fromIndex: number, toIndex: number) => { range = [fromIndex, toIndex]; return chain; },
      maybeSingle: async () => ({ data: (tables[table] ?? []).filter((row) => ops.every((op) => matches(row, op)))[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => {
        calls.push({ table, ops: [...ops] });
        const rows = (tables[table] ?? []).filter((row) => ops.every((op) => matches(row, op)));
        const limited = rows.slice(0, maximum ?? undefined);
        const paged = range ? limited.slice(range[0], range[1] + 1) : limited;
        return Promise.resolve({ data: paged, error: null }).then(resolve);
      },
    };
    return chain;
  };
  return { db: { from }, calls };
}

describe("loadManagerVendorSummary", () => {
  it("paginates all stable assigned jobs while preserving 0 and distinct money/rating values", async () => {
    const rows: Row[] = Array.from({ length: 501 }, (_, index) => ({ id: `target-${index}`, manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "p1", updated_at: String(index).padStart(4, "0"), row_data: { title: "Service", bucket: "completed" } }));
    rows.push({ id: "target", manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "p1", updated_at: "9999", row_data: { title: "Service", propertyName: "Home", bucket: "completed", residentConfirmation: { rating: 5 } } });
    const { db, calls } = fakeDb({
      manager_vendor_records: [{ id: "directory", manager_user_id: "owner", vendor_user_id: "vendor-user", row_data: {} }],
      portal_work_order_records: rows,
      work_order_bids: [{ work_order_id: "target", vendor_user_id: "vendor-user", status: "accepted", amount_cents: 0 }],
      vendor_invoices: [{ work_order_id: "target", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "approved", total_cents: 3100 }],
      vendor_payouts: [{ work_order_id: "target", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "paid", amount_cents: 2200 }],
    });
    const result = await loadManagerVendorSummary(db as never, "owner", "directory");
    expect(result).toMatchObject({ ok: true, summary: { totalJobCount: 502, ratingCount: 1, completedJobCount: 502, completedInvoiceTotalCents: 3100 } });
    if (!result.ok) throw new Error("expected summary");
    expect(result.summary.jobs).toHaveLength(100);
    expect(result.summary.jobs[0]).toEqual(expect.objectContaining({ id: "target", acceptedQuoteCents: 0, finalInvoiceCents: 3100, paidCents: 2200, residentRating: 5 }));
    expect(calls.find((call) => call.table === "portal_work_order_records")?.ops).toContainEqual(["eq", "vendor_user_id", "vendor-user"]);
  });

  it("scopes services separately from financials and rejects an unrelated manager", async () => {
    linkedOwnerScopeForModule
      .mockResolvedValueOnce({ propertyIdsByOwner: new Map([["owner", new Set(["allowed"])]] ) })
      .mockResolvedValueOnce({ propertyIdsByOwner: new Map([["owner", new Set()]]) });
    const { db, calls } = fakeDb({
      manager_vendor_records: [{ id: "directory", manager_user_id: "owner", vendor_user_id: "vendor-user", row_data: {} }],
      portal_work_order_records: [{ id: "allowed", manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "allowed", row_data: { bucket: "completed", residentConfirmation: { rating: 6 } } }],
      work_order_bids: [], vendor_invoices: [], vendor_payouts: [],
    });
    const result = await loadManagerVendorSummary(db as never, "co-manager", "directory");
    expect(result).toMatchObject({ ok: true, summary: { ratingCount: 0, completedInvoiceTotalCents: null } });
    if (!result.ok) throw new Error("expected summary");
    expect(result.summary.jobs[0]).toMatchObject({ acceptedQuoteCents: null, finalInvoiceCents: null, paidCents: null });
    expect(calls.find((call) => call.table === "portal_work_order_records")?.ops).toContainEqual(["in", "property_id", ["allowed"]]);
    linkedOwnerScopeForModule.mockResolvedValue({ propertyIdsByOwner: new Map() });
    await expect(loadManagerVendorSummary(db as never, "intruder", "directory")).resolves.toEqual({ ok: false, status: 403 });
  });

  it("uses the newest non-draft invoice and keeps zero money distinct from no invoice", async () => {
    const { db } = fakeDb({
      manager_vendor_records: [{ id: "directory", manager_user_id: "owner", vendor_user_id: "vendor-user", row_data: {} }],
      portal_work_order_records: [
        { id: "done", manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "p1", row_data: { title: "Done", bucket: "completed", residentConfirmation: { rating: 4 } } },
        { id: "draft-only", manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "p1", row_data: { title: "Draft", bucket: "in-progress", residentConfirmation: { rating: 5 } } },
      ],
      work_order_bids: [{ work_order_id: "done", vendor_user_id: "vendor-user", status: "accepted", amount_cents: 0 }],
      vendor_invoices: [
        { id: "old", work_order_id: "done", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "approved", total_cents: 1800, submitted_at: "2026-01-01" },
        { id: "new", work_order_id: "done", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "paid", total_cents: 0, submitted_at: "2026-02-01" },
        { id: "draft", work_order_id: "draft-only", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "draft", total_cents: 9999, submitted_at: "2026-03-01" },
      ],
      vendor_payouts: [{ work_order_id: "done", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "paid", amount_cents: 0 }],
    });
    const result = await loadManagerVendorSummary(db as never, "owner", "directory");
    expect(result).toMatchObject({ ok: true, summary: { completedInvoiceTotalCents: 0, completedInvoiceAverageCents: 0, ratingCount: 1 } });
    if (!result.ok) throw new Error("expected summary");
    expect(result.summary.jobs.find((job) => job.id === "done")).toMatchObject({ acceptedQuoteCents: 0, finalInvoiceCents: 0, paidCents: 0, residentRating: 4 });
    expect(result.summary.jobs.find((job) => job.id === "draft-only")).toMatchObject({ finalInvoiceCents: null, residentRating: null });
  });
});
