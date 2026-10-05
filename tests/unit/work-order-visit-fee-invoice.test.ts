import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertVendorInvoiceRow, resolveOwnVendorRecords } = vi.hoisted(() => ({
  insertVendorInvoiceRow: vi.fn(async () => ({ data: { id: "inv-1" }, error: null })),
  resolveOwnVendorRecords: vi.fn(async () => [{ id: "dir-1", managerUserId: "mgr-1", row: {} }]),
}));
vi.mock("@/lib/vendor-invoice-submit.server", () => ({ insertVendorInvoiceRow }));
vi.mock("@/lib/vendor-own-record", () => ({ resolveOwnVendorRecords }));

import { ensureVisitFeeInvoice, isGenuineVisitFeeInvoice } from "@/lib/work-order-visit-fee-invoice.server";

let EXISTING: Array<{ id: string; status: string }>;
let BID: Record<string, unknown> | null;

function db() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        limit: () => Promise.resolve({ data: EXISTING, error: null }),
        maybeSingle: async () => ({ data: table === "work_order_bids" ? BID : null, error: null }),
      };
      return builder;
    },
  } as never;
}

const INPUT = { bidId: "bid-1", workOrderId: "wo-1", managerUserId: "mgr-1", vendorUserId: "v-1", feeCents: 4_000, title: "Leaky faucet" };

beforeEach(() => {
  vi.clearAllMocks();
  EXISTING = [];
  BID = null;
});

describe("ensureVisitFeeInvoice", () => {
  it("files one invoice keyed by the bid, for the stored fee", async () => {
    const result = await ensureVisitFeeInvoice(db(), INPUT);
    expect(result.created).toBe(true);
    expect(insertVendorInvoiceRow).toHaveBeenCalledTimes(1);
    const [, prepared, opts] = insertVendorInvoiceRow.mock.calls[0] as unknown as [unknown, { totalCents: number; lineItems: Array<{ description: string }> }, { invoiceNumber: string; visitFeeBidId: string }];
    expect(opts.invoiceNumber).toBe("VISIT-bid-1");
    // The server-owned marker: it is what every money guard reads, so this flow must set it.
    expect(opts.visitFeeBidId).toBe("bid-1");
    expect(prepared.totalCents).toBe(4_000);
    expect(prepared.lineItems[0]!.description).toMatch(/Estimate visit/);
  });

  it("is idempotent: an existing live fee invoice means nothing new is filed", async () => {
    EXISTING = [{ id: "inv-0", status: "submitted" }];
    expect((await ensureVisitFeeInvoice(db(), INPUT)).created).toBe(false);
    expect(insertVendorInvoiceRow).not.toHaveBeenCalled();
  });

  it("files nothing for a free visit", async () => {
    expect((await ensureVisitFeeInvoice(db(), { ...INPUT, feeCents: 0 })).created).toBe(false);
    expect(insertVendorInvoiceRow).not.toHaveBeenCalled();
  });

  it("treats a unique-index collision (a racing call) as already filed", async () => {
    insertVendorInvoiceRow.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "dup" } } as never);
    expect((await ensureVisitFeeInvoice(db(), INPUT)).created).toBe(false);
  });
});

describe("isGenuineVisitFeeInvoice", () => {
  const invoice = { estimate_visit_bid_id: "bid-1", work_order_id: "wo-1", vendor_user_id: "v-1", manager_user_id: "mgr-1", total_cents: 4_000 };
  const bid = { id: "bid-1", work_order_id: "wo-1", vendor_user_id: "v-1", manager_user_id: "mgr-1", estimate_visit_done_at: "2026-10-05T18:00:00.000Z", estimate_visit_fee_cents: 4_000 };

  it("accepts only an invoice that matches a real bid whose visit happened at that fee", async () => {
    BID = bid;
    expect(await isGenuineVisitFeeInvoice(db(), invoice)).toBe(true);
  });

  it("rejects a self-filed look-alike: wrong amount, visit not done, another vendor, or no bid", async () => {
    BID = bid;
    expect(await isGenuineVisitFeeInvoice(db(), { ...invoice, total_cents: 9_000 })).toBe(false);
    expect(await isGenuineVisitFeeInvoice(db(), { ...invoice, vendor_user_id: "v-2" })).toBe(false);
    expect(await isGenuineVisitFeeInvoice(db(), { ...invoice, work_order_id: "wo-2" })).toBe(false);
    BID = { ...bid, estimate_visit_done_at: null };
    expect(await isGenuineVisitFeeInvoice(db(), invoice)).toBe(false);
    BID = null;
    expect(await isGenuineVisitFeeInvoice(db(), invoice)).toBe(false);
  });

  // `invoice_number` is whatever the vendor typed; only the server sets `estimate_visit_bid_id`.
  it("ignores a VISIT- invoice number with no server marker", async () => {
    BID = bid;
    expect(
      await isGenuineVisitFeeInvoice(db(), {
        ...invoice,
        estimate_visit_bid_id: null,
        invoice_number: "VISIT-bid-1",
      } as never),
    ).toBe(false);
  });
});

describe("vendor_invoice_estimate_visit_marker migration", () => {
  const sql = readFileSync("supabase/migrations/20261004150000_vendor_invoice_estimate_visit_marker.sql", "utf8");
  it("adds the server-owned marker column idempotently", () => {
    expect(sql).toMatch(/add column if not exists estimate_visit_bid_id uuid references public\.work_order_bids/);
    expect(sql).toMatch(/create index if not exists vendor_invoices_estimate_visit_bid_idx/);
  });
  it("backfills only rows that pass the genuineness conditions", () => {
    for (const condition of [
      "b.work_order_id = i.work_order_id",
      "b.vendor_user_id = i.vendor_user_id",
      "b.manager_user_id = i.manager_user_id",
      "b.estimate_visit_done_at is not null",
      "b.estimate_visit_fee_cents = i.total_cents",
    ]) {
      expect(sql).toContain(condition);
    }
    expect(sql).toMatch(/i\.estimate_visit_bid_id is null/);
  });
  it("changes no RLS or grants", () => {
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/create policy|alter policy|drop policy|grant |revoke |row level security/i);
  });
});

describe("work_order_bid_estimates migration", () => {
  const sql = readFileSync("supabase/migrations/20261003231000_work_order_bid_estimates.sql", "utf8");
  it("adds the five columns idempotently", () => {
    for (const column of ["estimate_cents", "estimate_given_at", "bid_submitted_at", "estimate_visit_fee_cents", "estimate_visit_done_at"]) {
      expect(sql).toMatch(new RegExp(`add column if not exists[\\s\\S]*${column}`));
    }
    expect(sql).toMatch(/estimate_cents is null or estimate_cents > 0/);
    expect(sql).toMatch(/estimate_visit_fee_cents >= 0/);
  });
  it("changes no RLS or grants - vendors stay SELECT-only", () => {
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/create policy|alter policy|drop policy|grant |revoke |row level security/i);
  });
});
