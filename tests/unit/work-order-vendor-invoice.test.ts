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
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";
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

  it("files nothing when the vendor has no roster row under THIS work order's manager", async () => {
    // `resolveOwnVendorRecords` spans every manager the vendor is on, so falling
    // back to the first row filed the bill under an unrelated manager - who
    // could then see and pay a job that was never theirs.
    vi.mocked(insertVendorInvoiceRow).mockClear();
    vi.mocked(resolveOwnVendorRecords).mockResolvedValueOnce([
      { managerUserId: "mgr-OTHER", id: "vendor-row-9", row: { name: "Dana" } },
    ] as never);
    const db = {
      from: (table: string) => {
        if (table === "vendor_invoices") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
        }
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { amount_cents: 12_000, materials_cents: 0, status: "accepted" } }) }) }),
          }),
        };
      },
    };
    await ensureSubmittedVendorInvoiceForMarkedDone(db as never, {
      workOrderId: "wo-3",
      managerUserId: "mgr-1",
      vendorUserId: "vendor-user-1",
      row: { title: "Move-out clean", vendorCostCents: 12_000, assignee: { type: "vendor", id: "v1", name: "Dana" } } as DemoManagerWorkOrderRow,
    });
    expect(insertVendorInvoiceRow).not.toHaveBeenCalled();
  });
});
