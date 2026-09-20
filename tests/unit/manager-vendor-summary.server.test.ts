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
    const orders: Array<{ key: string; ascending: boolean }> = [];
    let maximum: number | null = null;
    let range: [number, number] | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (key: string, value: unknown) => { ops.push(["eq", key, value]); return chain; },
      in: (key: string, value: unknown) => { ops.push(["in", key, value]); return chain; },
      contains: (key: string, value: unknown) => { ops.push(["contains", key, value]); return chain; },
      order: (key: string, options?: { ascending?: boolean }) => { orders.push({ key, ascending: options?.ascending !== false }); return chain; },
      limit: (value: number) => { maximum = value; return chain; },
      range: (fromIndex: number, toIndex: number) => { range = [fromIndex, toIndex]; return chain; },
      maybeSingle: async () => ({ data: (tables[table] ?? []).filter((row) => ops.every((op) => matches(row, op)))[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => {
        calls.push({ table, ops: [...ops] });
        const rows = (tables[table] ?? []).filter((row) => ops.every((op) => matches(row, op))).sort((left, right) => {
          for (const { key, ascending } of orders) {
            const a = String(left[key] ?? "");
            const b = String(right[key] ?? "");
            const comparison = a.localeCompare(b);
            if (comparison !== 0) return ascending ? comparison : -comparison;
          }
          return 0;
        });
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
    const rows: Row[] = Array.from({ length: 501 }, (_, index) => ({ id: `target-${String(index).padStart(4, "0")}`, manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "p1", updated_at: "2026-01-01", row_data: { title: "Service", bucket: "completed" } }));
    rows.push({ id: "target", manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "p1", updated_at: "2026-12-31", row_data: { title: "Service", propertyName: "Home", bucket: "completed", residentConfirmation: { rating: 5 } } });
    const { db, calls } = fakeDb({
      manager_vendor_records: [{ id: "directory", manager_user_id: "owner", vendor_user_id: "vendor-user", row_data: {} }],
      portal_work_order_records: rows,
      work_order_bids: [
        ...Array.from({ length: 501 }, (_, index) => ({ id: `bid-${String(index).padStart(4, "0")}`, work_order_id: `target-${String(index).padStart(4, "0")}`, vendor_user_id: "vendor-user", status: "accepted", amount_cents: index })),
        { id: "bid-target", work_order_id: "target", vendor_user_id: "vendor-user", status: "accepted", amount_cents: 0 },
      ],
      vendor_invoices: [{ work_order_id: "target", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "approved", total_cents: 3100 }],
      vendor_payouts: [{ work_order_id: "target", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "paid", amount_cents: 2200 }],
    });
    const result = await loadManagerVendorSummary(db as never, "owner", "directory");
    expect(result).toMatchObject({ ok: true, summary: { totalJobCount: 502, ratingCount: 1, completedJobCount: 502, completedInvoiceTotalCents: 3100 } });
    if (!result.ok) throw new Error("expected summary");
    expect(result.summary.jobs).toHaveLength(100);
    expect(result.summary.jobs[0]).toEqual(expect.objectContaining({ id: "target", acceptedQuoteCents: 0, finalInvoiceCents: 3100, paidCents: 2200, residentRating: 5 }));
    expect(calls.find((call) => call.table === "portal_work_order_records")?.ops).toContainEqual(["eq", "vendor_user_id", "vendor-user"]);
    expect(calls.filter((call) => call.table === "portal_work_order_records")).toHaveLength(2);
    expect(calls.filter((call) => call.table === "work_order_bids").length).toBeGreaterThan(1);
  });

  it("scopes services separately from financials and rejects an unrelated manager", async () => {
    linkedOwnerScopeForModule
      .mockResolvedValueOnce({ propertyIdsByOwner: new Map([["owner", new Set(["allowed"])]] ) })
      .mockResolvedValueOnce({ propertyIdsByOwner: new Map([["owner", new Set()]]) });
    const { db, calls } = fakeDb({
      manager_vendor_records: [{ id: "directory", manager_user_id: "owner", vendor_user_id: "vendor-user", row_data: {} }],
      portal_work_order_records: [
        { id: "older", manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "allowed", updated_at: "2026-01-01", row_data: { title: "Older", bucket: "completed", residentConfirmation: { rating: 5 } } },
        { id: "newer", manager_user_id: "owner", vendor_user_id: "vendor-user", assigned_property_id: "allowed", updated_at: "2026-02-01", row_data: { title: "Newer", bucket: "completed", residentConfirmation: { rating: 4 } } },
        { id: "other-owner", manager_user_id: "other", vendor_user_id: "vendor-user", property_id: "allowed", updated_at: "2026-03-01", row_data: { title: "Other", bucket: "completed", residentConfirmation: { rating: 5 } } },
      ],
      work_order_bids: [{ id: "accepted", work_order_id: "newer", vendor_user_id: "vendor-user", status: "accepted", amount_cents: 700 }], vendor_invoices: [], vendor_payouts: [],
    });
    const result = await loadManagerVendorSummary(db as never, "co-manager", "directory");
    expect(result).toMatchObject({ ok: true, summary: { ratingCount: 2, completedInvoiceTotalCents: null } });
    if (!result.ok) throw new Error("expected summary");
    expect(result.summary.jobs.map((job) => job.id)).toEqual(["newer", "older"]);
    expect(result.summary.jobs[0]).toMatchObject({ acceptedQuoteCents: 700, finalInvoiceCents: null, paidCents: null, residentRating: 4 });
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

  it("returns finance values only for the co-manager properties that grant financials read", async () => {
    linkedOwnerScopeForModule
      .mockResolvedValueOnce({ propertyIdsByOwner: new Map([["owner", new Set(["services-only", "financials-ok"])]]) })
      .mockResolvedValueOnce({ propertyIdsByOwner: new Map([["owner", new Set(["financials-ok"])]]) });
    const { db } = fakeDb({
      manager_vendor_records: [{ id: "directory", manager_user_id: "owner", vendor_user_id: "vendor-user", row_data: {} }],
      portal_work_order_records: [
        { id: "redacted", manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "services-only", updated_at: "2026-02-01", row_data: { title: "Service only", bucket: "completed" } },
        { id: "visible", manager_user_id: "owner", vendor_user_id: "vendor-user", property_id: "financials-ok", updated_at: "2026-01-01", row_data: { title: "Finance", bucket: "completed" } },
      ],
      work_order_bids: [],
      vendor_invoices: [
        { id: "invoice-redacted", work_order_id: "redacted", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "approved", total_cents: 900 },
        { id: "invoice-visible", work_order_id: "visible", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "approved", total_cents: 1200 },
      ],
      vendor_payouts: [
        { id: "payout-redacted", work_order_id: "redacted", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "paid", amount_cents: 900 },
        { id: "payout-visible", work_order_id: "visible", manager_user_id: "owner", vendor_user_id: "vendor-user", status: "paid", amount_cents: 1200 },
      ],
    });
    const result = await loadManagerVendorSummary(db as never, "co-manager", "directory");
    if (!result.ok) throw new Error("expected summary");
    expect(result.summary.completedInvoiceTotalCents).toBe(1200);
    expect(result.summary.jobs.find((job) => job.id === "redacted")).toMatchObject({ finalInvoiceCents: null, paidCents: null });
    expect(result.summary.jobs.find((job) => job.id === "visible")).toMatchObject({ finalInvoiceCents: 1200, paidCents: 1200 });
  });
});
