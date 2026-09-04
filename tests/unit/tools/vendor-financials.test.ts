import { describe, it, expect } from "vitest";
import { agentRegistry } from "@/lib/tools";
import { vendorAgentRegistry } from "@/lib/tools/vendor-index";
import {
  listVendorInvoicesTool,
  listVendorPayoutsTool,
  submitVendorInvoiceTool,
} from "@/lib/tools/domains/vendor-financials";
import {
  canTransitionVendorInvoice,
  formatInvoiceMoney,
  normalizeLineItems,
  sumLineItemsCents,
  vendorInvoiceBadgeTone,
  VENDOR_INVOICE_STATUSES,
} from "@/lib/vendor-invoices";
import { makeManagerRowsCtx, makeWritableCtx } from "./fake-agent-ctx";

function vendorInvoiceRow(vendorUserId: string, id: string, status: string, total: number) {
  return {
    id,
    vendor_user_id: vendorUserId,
    vendor_id: "vendor-dir-1",
    work_order_id: null,
    invoice_number: id,
    line_items: [{ description: "x", quantity: 1, unitAmountCents: total, amountCents: total }],
    subtotal_cents: total,
    tax_cents: 0,
    total_cents: total,
    currency: "usd",
    status,
    memo: null,
    decision_note: null,
    bill_id: null,
    submitted_at: "2026-07-01T00:00:00Z",
    decided_at: null,
    paid_at: null,
    created_at: "2026-07-01T00:00:00Z",
  } as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number];
}

function payoutRow(vendorUserId: string, id: string, status: string) {
  return {
    id,
    vendor_user_id: vendorUserId,
    work_order_id: "wo-1",
    amount_cents: 5000,
    stripe_transfer_id: null,
    status,
    failure_reason: null,
    created_at: "2026-07-01T00:00:00Z",
  } as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number];
}

describe("vendor-financials tool map safety", () => {
  it("never exposes a W-9 / TIN / tax-profile / 1099 tool in either registry", () => {
    const names = [...agentRegistry.values(), ...vendorAgentRegistry.values()].map((t) => t.name.toLowerCase());
    // No tool NAME may surface a tax-identifier capability to the model. Matched
    // on whole name SEGMENTS, not raw substrings, so an innocent name like
    // get_automation_set-tin-gs is not a false positive.
    const forbiddenSegments = new Set(["tax", "taxes", "w9", "tin", "ssn", "1099"]);
    for (const name of names) {
      for (const segment of name.split(/[_-]/)) {
        expect(forbiddenSegments.has(segment), `${name} exposes a tax-identifier capability`).toBe(false);
      }
      for (const token of ["1099", "w_9", "w-9", "w9"]) {
        expect(name.includes(token), `${name} exposes a tax-identifier capability`).toBe(false);
      }
    }
  });

  it("registers the vendor-portal tools separately from the manager map", () => {
    const vendorNames = new Set([...vendorAgentRegistry.values()].map((t) => t.name));
    expect(vendorNames).toEqual(
      new Set([
        "list_my_jobs",
        "get_job_details",
        "list_my_bids",
        "list_my_offers",
        "submit_bid",
        "set_my_price",
        "mark_job_done",
        "list_my_payouts",
        "get_my_profile",
        "list_vendor_invoices",
        "submit_vendor_invoice",
        "list_vendor_payouts",
        "get_my_availability",
        "update_my_availability",
        "list_my_schedule",
        "list_my_inbox_threads",
        "send_message_to_manager",
      ]),
    );
    // The manager map must not inherit the vendor-scoped tools.
    const managerNames = new Set([...agentRegistry.values()].map((t) => t.name));
    for (const n of vendorNames) expect(managerNames.has(n)).toBe(false);
  });

  it("submit_vendor_invoice is a gated write; the reads are read tools", () => {
    const byName = new Map([...vendorAgentRegistry.values()].map((t) => [t.name, t]));
    expect(byName.get("submit_vendor_invoice")?.kind).toBe("write");
    expect(byName.get("list_vendor_invoices")?.kind).toBe("read");
    expect(byName.get("list_vendor_payouts")?.kind).toBe("read");
  });
});

describe("vendor invoice scoping", () => {
  it("list_vendor_invoices returns only the caller's own invoices", async () => {
    const ctx = makeManagerRowsCtx(
      {
        vendor_invoices: [
          vendorInvoiceRow("vendor_a", "inv-a1", "submitted", 1000),
          vendorInvoiceRow("vendor_a", "inv-a2", "paid", 2000),
          vendorInvoiceRow("vendor_b", "inv-b1", "submitted", 9999),
        ],
      },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    const result = (await listVendorInvoicesTool.handler(ctx, {})) as {
      count: number;
      invoices: { id: string }[];
    };
    expect(result.count).toBe(2);
    expect(result.invoices.map((i) => i.id).sort()).toEqual(["inv-a1", "inv-a2"]);
  });

  it("list_vendor_payouts returns only the caller's own payouts", async () => {
    const ctx = makeManagerRowsCtx(
      {
        vendor_payouts: [payoutRow("vendor_a", "p-a", "paid"), payoutRow("vendor_b", "p-b", "paid")],
      },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    const result = (await listVendorPayoutsTool.handler(ctx, {})) as {
      count: number;
      payouts: { id: string }[];
    };
    expect(result.count).toBe(1);
    expect(result.payouts[0]?.id).toBe("p-a");
  });

  it("submit_vendor_invoice refuses to guess between multiple linked managers", async () => {
    const link = (id: string, managerUserId: string) =>
      ({
        id,
        manager_user_id: managerUserId,
        vendor_user_id: "vendor_a",
        row_data: { id, name: "Vendor A" },
        updated_at: "2026-07-01T00:00:00Z",
      }) as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number];
    const ctx = makeManagerRowsCtx(
      { manager_vendor_records: [link("dir-1", "manager_a"), link("dir-2", "manager_b")] },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    await expect(
      submitVendorInvoiceTool.handler(ctx, {
        lineItems: [{ description: "Labor", quantity: 1, unitAmountCents: 5000 }],
      }),
    ).rejects.toThrow(/choose which manager/i);
  });

  it("submit_vendor_invoice rejects a work order id that does not exist", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_vendor_records: [
          {
            id: "dir-1",
            manager_user_id: "manager_a",
            vendor_user_id: "vendor_a",
            row_data: { id: "dir-1", name: "Vendor A" },
          } as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number],
        ],
      },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    await expect(
      submitVendorInvoiceTool.handler(ctx, {
        workOrderId: "wo-missing",
        lineItems: [{ description: "Labor", quantity: 1, unitAmountCents: 5000 }],
      }),
    ).rejects.toThrow(/work order not found/i);
  });

  it("submit_vendor_invoice rejects a work order owned by another manager or vendor", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_vendor_records: [
          {
            id: "dir-1",
            manager_user_id: "manager_a",
            vendor_user_id: "vendor_a",
            row_data: { id: "dir-1", name: "Vendor A" },
          } as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number],
        ],
        portal_work_order_records: [
          {
            id: "wo-foreign",
            manager_user_id: "manager_b",
            vendor_user_id: "vendor_a",
            row_data: {},
          } as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number],
          {
            id: "wo-unassigned",
            manager_user_id: "manager_a",
            vendor_user_id: "vendor_b",
            row_data: {},
          } as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number],
        ],
      },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    for (const workOrderId of ["wo-foreign", "wo-unassigned"]) {
      await expect(
        submitVendorInvoiceTool.handler(ctx, {
          workOrderId,
          lineItems: [{ description: "Labor", quantity: 1, unitAmountCents: 5000 }],
        }),
      ).rejects.toThrow(/work order not found/i);
    }
  });
});

describe("submit_vendor_invoice preview/confirm gate", () => {
  const vendorLink = {
    id: "dir-1",
    manager_user_id: "manager_a",
    vendor_user_id: "vendor_a",
    row_data: { id: "dir-1", name: "Vendor A" },
  };
  const lineItems = [
    { description: "Labor", quantity: 3, unitAmountCents: 5000 },
    { description: "Parts", quantity: 2, unitAmountCents: 2500 },
  ];

  it("is a previewable write tool, so it is reachable from vendor chat", () => {
    expect(submitVendorInvoiceTool.kind).toBe("write");
    expect(typeof submitVendorInvoiceTool.preview).toBe("function");
  });

  it("preview shows the resolved work order, line items, and server-recomputed total", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_vendor_records: [vendorLink as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number]],
        portal_work_order_records: [
          {
            id: "wo-1",
            manager_user_id: "manager_a",
            vendor_user_id: "vendor_a",
            row_data: { title: "Kitchen faucet leak" },
          } as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number],
        ],
      },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    const preview = await submitVendorInvoiceTool.preview!(ctx, {
      workOrderId: "wo-1",
      lineItems,
      taxCents: 1000,
    });
    expect(preview.kind).toBe("submit_vendor_invoice");
    const byLabel = new Map(preview.fields.map((f) => [f.label, f.value]));
    expect(byLabel.get("Work order")).toBe("Kitchen faucet leak (wo-1)");
    expect(byLabel.get("Tax")).toBe(formatInvoiceMoney(1000));
    expect(byLabel.get("Total")).toBe(formatInvoiceMoney(21000));
    expect(byLabel.get("Bill to")).toBe("your property manager");
    expect(byLabel.get("Labor")).toContain(formatInvoiceMoney(15000));
  });

  it("preview falls back to the bare work-order id when the title is missing or blank", async () => {
    for (const rowData of [{}, { title: "   " }, { title: 42 }]) {
      const ctx = makeManagerRowsCtx(
        {
          manager_vendor_records: [
            vendorLink as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number],
          ],
          portal_work_order_records: [
            {
              id: "wo-1",
              manager_user_id: "manager_a",
              vendor_user_id: "vendor_a",
              row_data: rowData,
            } as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number],
          ],
        },
        { userId: "vendor_a", roles: ["vendor"] },
      );
      const preview = await submitVendorInvoiceTool.preview!(ctx, { workOrderId: "wo-1", lineItems });
      const byLabel = new Map(preview.fields.map((f) => [f.label, f.value]));
      expect(byLabel.get("Work order")).toBe("wo-1");
    }
  });

  it("preview refuses to guess between multiple linked managers", async () => {
    const otherLink = { ...vendorLink, id: "dir-2", manager_user_id: "manager_b" };
    const ctx = makeManagerRowsCtx(
      {
        manager_vendor_records: [vendorLink, otherLink] as unknown as Parameters<
          typeof makeManagerRowsCtx
        >[0][string],
      },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    await expect(submitVendorInvoiceTool.preview!(ctx, { lineItems })).rejects.toThrow(/choose which manager/i);
  });

  it("handler writes the invoice and records its id on the audit row", async () => {
    const { ctx, store } = makeWritableCtx(
      { manager_vendor_records: [vendorLink] },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    const result = await submitVendorInvoiceTool.handler(ctx, { lineItems, taxCents: 1000 });
    expect(store.vendor_invoices).toHaveLength(1);
    const invoice = store.vendor_invoices![0]!;
    expect(invoice.total_cents).toBe(21000);
    expect(invoice.vendor_user_id).toBe("vendor_a");
    expect(store.audit_log).toHaveLength(1);
    expect(store.audit_log![0]!.result_summary).toEqual({ invoiceId: invoice.id, totalCents: 21000 });
    expect(result.reply).toContain(formatInvoiceMoney(21000));
  });

  it("handler marks the audit row as unsaved when the invoice insert fails", async () => {
    const { ctx, store } = makeWritableCtx(
      { manager_vendor_records: [vendorLink] },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    const db = ctx.db as { from: (table: string) => unknown };
    const realFrom = db.from.bind(db);
    db.from = (table: string) => {
      if (table !== "vendor_invoices") return realFrom(table);
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { message: "insert failed" } }),
          }),
        }),
      };
    };
    await expect(submitVendorInvoiceTool.handler(ctx, { lineItems })).rejects.toThrow(/insert failed/);
    expect(store.vendor_invoices ?? []).toHaveLength(0);
    expect(store.audit_log).toHaveLength(1);
    expect(store.audit_log![0]!.result_summary).toEqual({ saved: false });
  });

  it("surfaces a work-order lookup DB error instead of misreporting not-found", async () => {
    const ctx = makeManagerRowsCtx(
      {
        manager_vendor_records: [vendorLink as unknown as Parameters<typeof makeManagerRowsCtx>[0][string][number]],
      },
      { userId: "vendor_a", roles: ["vendor"] },
    );
    const db = ctx.db as { from: (table: string) => unknown };
    const realFrom = db.from.bind(db);
    db.from = (table: string) => {
      if (table !== "portal_work_order_records") return realFrom(table);
      const failing = {
        select: () => failing,
        eq: () => failing,
        maybeSingle: async () => ({ data: null, error: { message: "db unavailable" } }),
      };
      return failing;
    };
    await expect(
      submitVendorInvoiceTool.handler(ctx, { workOrderId: "wo-1", lineItems }),
    ).rejects.toThrow(/could not verify the work order/i);
  });
});

describe("vendor invoice status transitions", () => {
  it("follows submitted → approved/rejected → scheduled → paid", () => {
    expect(canTransitionVendorInvoice("submitted", "approved")).toBe(true);
    expect(canTransitionVendorInvoice("submitted", "rejected")).toBe(true);
    expect(canTransitionVendorInvoice("submitted", "paid")).toBe(false);
    expect(canTransitionVendorInvoice("approved", "scheduled")).toBe(true);
    expect(canTransitionVendorInvoice("approved", "paid")).toBe(true);
    expect(canTransitionVendorInvoice("scheduled", "paid")).toBe(true);
    expect(canTransitionVendorInvoice("scheduled", "rejected")).toBe(false);
  });

  it("treats paid and rejected as terminal and repeats as non-transitions", () => {
    for (const to of VENDOR_INVOICE_STATUSES) {
      expect(canTransitionVendorInvoice("paid", to)).toBe(false);
      expect(canTransitionVendorInvoice("rejected", to)).toBe(false);
    }
    for (const status of VENDOR_INVOICE_STATUSES) {
      expect(canTransitionVendorInvoice(status, status)).toBe(false);
    }
  });
});

describe("vendor invoice helpers", () => {
  it("recomputes line-item amounts server-side (ignores any supplied total)", () => {
    const items = normalizeLineItems([
      { description: "Labor", quantity: 3, unitAmountCents: 5000, amountCents: 999999 },
      { description: "Parts", quantity: 2, unitAmountCents: 2500 },
    ]);
    expect(items[0]?.amountCents).toBe(15000);
    expect(items[1]?.amountCents).toBe(5000);
    expect(sumLineItemsCents(items)).toBe(20000);
  });

  it("maps invoice status onto the four shared Badge tones", () => {
    expect(vendorInvoiceBadgeTone("submitted")).toBe("pending");
    expect(vendorInvoiceBadgeTone("approved")).toBe("approved");
    expect(vendorInvoiceBadgeTone("scheduled")).toBe("approved");
    expect(vendorInvoiceBadgeTone("paid")).toBe("confirmed");
    expect(vendorInvoiceBadgeTone("rejected")).toBe("overdue");
  });
});
