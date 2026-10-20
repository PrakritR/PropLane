/**
 * The manager's Y on a texted invoice: the approved amount becomes the service's vendor cost, and on a PropLane-managed
 * workspace the bill is gated on the owner's repair threshold and posted to the party ledger under the job's own key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb } from "../helpers/owner-fake-db";

const gate = vi.hoisted(() => ({ calls: [] as Array<{ bill: Record<string, unknown>; gateOnly: boolean }>, status: "cleared" as "cleared" | "pending_owner" | "declined" | "posted", throws: false }));
const managedWs = vi.hoisted(() => ({ value: { workspaceId: "ws-1", policy: {} } as unknown, throws: false }));
const settle = vi.hoisted(() => ({ claim: vi.fn(async () => undefined), settle: vi.fn(async () => undefined), refuse: false }));

vi.mock("@/lib/managed-finance/vendor-bills.server", () => ({
  gateAndPostManagedVendorBill: async (_db: unknown, bill: Record<string, unknown>, _now: Date, opts?: { gateOnly?: boolean }) => {
    gate.calls.push({ bill, gateOnly: opts?.gateOnly === true });
    if (gate.throws) throw new Error("ledger down");
    if (opts?.gateOnly) return gate.status === "posted" ? { status: "cleared", expenseId: "e1" } : { status: gate.status, expenseId: "e1" };
    return { status: "posted", journalId: "j1", created: true };
  },
}));
vi.mock("@/lib/managed-finance/resolve.server", () => ({
  resolveManagedForProperties: async () => { if (managedWs.throws) throw new Error("read failed"); return managedWs.value; },
}));
vi.mock("@/lib/vendor-invoice-settlement.server", () => ({
  claimInvoicePayment: async (...args: unknown[]) => {
    if (settle.refuse) { const e = new Error("already paid"); (e as { name: string }).name = "VendorInvoicePaymentRefusal"; throw e; }
    return settle.claim(...(args as [])); },
  settleInvoicePayment: (...args: unknown[]) => settle.settle(...(args as [])),
}));
vi.mock("@/lib/vendor-invoices", async (orig) => ({
  ...(await orig<typeof import("@/lib/vendor-invoices")>()),
  isVendorInvoicePaymentRefusal: (e: unknown) => (e as { name?: string })?.name === "VendorInvoicePaymentRefusal",
}));

import { applyApprovedDispatchInvoice, setServiceVendorCost } from "@/lib/vendor-dispatch/invoice-managed.server";

const run = {
  id: "run-1", owner_user_id: "mgr", workspace_id: "ws-1", handle: 7, source_type: "work_order", source_id: "wo-1", property_id: "p-1",
  details: { what: "Leaking faucet" },
} as never;
const NOW = new Date("2026-10-19T18:00:00Z");

beforeEach(() => {
  gate.calls.length = 0; gate.status = "cleared"; gate.throws = false;
  managedWs.value = { workspaceId: "ws-1", policy: {} }; managedWs.throws = false;
  settle.claim.mockClear(); settle.settle.mockClear(); settle.refuse = false;
});

describe("setServiceVendorCost", () => {
  const db = (row: Record<string, unknown>) => fakeOwnerDb({ portal_work_order_records: [{ id: "wo-1", manager_user_id: "mgr", row_data: row }] });
  it("makes the approved invoice amount the service's vendor cost", async () => {
    const f = db({ vendorCostCents: 20_000, title: "Leak" });
    expect(await setServiceVendorCost(f.db, run, 35_000, NOW.toISOString())).toBe(true);
    expect((f.rows.portal_work_order_records![0]!.row_data as { vendorCostCents: number }).vendorCostCents).toBe(35_000);
  });
  it("never rewrites a service that is already paid", async () => {
    const f = db({ vendorCostCents: 20_000, automationStatus: "paid", paidAt: "2026-10-18" });
    expect(await setServiceVendorCost(f.db, run, 35_000, NOW.toISOString())).toBe(false);
    expect((f.rows.portal_work_order_records![0]!.row_data as { vendorCostCents: number }).vendorCostCents).toBe(20_000);
  });
  it("ignores a job that is not a work order and a nonsense amount", async () => {
    const f = db({});
    expect(await setServiceVendorCost(f.db, { ...(run as object), source_type: "tour" } as never, 35_000, NOW.toISOString())).toBe(false);
    expect(await setServiceVendorCost(f.db, run, 0, NOW.toISOString())).toBe(false);
    expect(await setServiceVendorCost(f.db, run, 12.5, NOW.toISOString())).toBe(false);
  });
});

describe("applyApprovedDispatchInvoice", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    run, amountCents: 35_000, invoiceId: "inv-1", vendorUserId: "ven-1", vendorDirectoryId: "vendor-abc", vendorName: "Pat Plumbing", now: NOW, ...over,
  }) as never;

  it("a self-serve workspace is left alone (the AP bill is all that happens)", async () => {
    managedWs.value = null;
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input())).toBe("not_managed");
    expect(gate.calls).toHaveLength(0);
  });

  it("a managed workspace over the owner's threshold waits for the owner and posts nothing", async () => {
    gate.status = "pending_owner";
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input())).toBe("waiting_owner");
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]!.gateOnly).toBe(true);
    expect(settle.claim).not.toHaveBeenCalled();
  });

  it("an owner who declined stops it", async () => {
    gate.status = "declined";
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input())).toBe("declined");
    expect(gate.calls.filter((c) => !c.gateOnly)).toHaveLength(0);
  });

  it("a cleared bill with a vendor account posts under the work order's key, claims the invoice once and settles it", async () => {
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input())).toBe("posted");
    const posted = gate.calls.find((c) => !c.gateOnly)!;
    expect(posted.bill).toMatchObject({
      workspaceId: "ws-1", vendorUserId: "ven-1", vendorDirectoryId: null, amountCents: 35_000,
      sourceType: "work_order", sourceId: "wo-1", propertyId: "p-1",
    });
    expect(settle.claim).toHaveBeenCalledTimes(1);
    expect(settle.settle).toHaveBeenCalledTimes(1);
  });

  it("a vendor with no login posts to their directory row and touches no invoice rail", async () => {
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input({ invoiceId: null, vendorUserId: null }))).toBe("posted");
    expect(gate.calls.find((c) => !c.gateOnly)!.bill).toMatchObject({ vendorUserId: null, vendorDirectoryId: "vendor-abc", sourceType: "work_order", sourceId: "wo-1" });
    expect(settle.claim).not.toHaveBeenCalled();
  });

  it("a job that is not a work order posts under the dispatch run", async () => {
    await applyApprovedDispatchInvoice(fakeOwnerDb().db, input({ run: { ...(run as object), source_type: "tour", source_id: "t-1" }, invoiceId: null, vendorUserId: null }));
    expect(gate.calls.find((c) => !c.gateOnly)!.bill).toMatchObject({ sourceType: "manual", sourceId: "dispatch-run:run-1" });
  });

  it("an invoice another rail already paid is not paid twice", async () => {
    settle.refuse = true;
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input())).toBe("unavailable");
    expect(gate.calls.filter((c) => !c.gateOnly)).toHaveLength(0);
    expect(settle.settle).not.toHaveBeenCalled();
  });

  it("a ledger failure or an unreadable workspace is reported, never swallowed as success", async () => {
    gate.throws = true;
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input())).toBe("unavailable");
    managedWs.throws = true;
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input())).toBe("unavailable");
  });

  it("ignores an amount under $1", async () => {
    expect(await applyApprovedDispatchInvoice(fakeOwnerDb().db, input({ amountCents: 50 }))).toBe("not_managed");
  });
});
