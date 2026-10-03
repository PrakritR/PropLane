import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/vendor-own-record", () => ({
  resolveOwnVendorRecords: vi.fn(async () => [{ managerUserId: "mgr-1", id: "vendor-row-1", row: { name: "Dana" } }]),
}));
vi.mock("@/lib/vendor-invoice-submit.server", () => ({
  insertVendorInvoiceRow: vi.fn(async () => ({ error: null })),
}));

import { ensureSubmittedVendorInvoiceForMarkedDone } from "@/lib/work-order-vendor-invoice.server";
import { insertVendorInvoiceRow } from "@/lib/vendor-invoice-submit.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

describe("ensureSubmittedVendorInvoiceForMarkedDone", () => {
  it("skips team jobs and inserts a submitted invoice for vendor work", async () => {
    const db = {
      from: (table: string) => {
        if (table === "vendor_invoices") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null }),
              }),
            }),
          };
        }
        if (table === "work_order_bids") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { amount_cents: 12_000, materials_cents: 0, status: "accepted" } }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };

    const row = {
      title: "Move-out clean",
      vendorCostCents: 12_000,
      assignee: { type: "vendor", id: "v1", name: "Dana" },
    } as DemoManagerWorkOrderRow;

    await ensureSubmittedVendorInvoiceForMarkedDone(db as never, {
      workOrderId: "wo-1",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-user-1",
      row,
    });

    expect(insertVendorInvoiceRow).toHaveBeenCalled();
  });

  it("does not bill self-assigned team work", async () => {
    vi.mocked(insertVendorInvoiceRow).mockClear();
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null }),
          }),
        }),
      }),
    };
    await ensureSubmittedVendorInvoiceForMarkedDone(db as never, {
      workOrderId: "wo-2",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-user-1",
      row: { selfAssigned: true, title: "DIY" } as DemoManagerWorkOrderRow,
    });
    expect(insertVendorInvoiceRow).not.toHaveBeenCalled();
  });
});
