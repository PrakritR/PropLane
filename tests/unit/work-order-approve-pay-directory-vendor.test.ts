/**
 * Approve + pay on a PropLane-managed workspace for a vendor texted by dispatch who has no login: the bill posts to the vendor's
 * directory row (nothing is refused), the service is marked paid without a payout row, and the vendor is told money is waiting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type OwnerFakeDb } from "../helpers/owner-fake-db";

const s = vi.hoisted(() => ({
  managed: { workspaceId: "ws-1", policy: {} } as unknown,
  bills: [] as Array<{ bill: Record<string, unknown>; gateOnly: boolean }>,
  gate: "cleared" as string,
  texted: [] as string[],
  expenses: 0,
}));

vi.mock("@/lib/managed-finance/resolve.server", () => ({ resolveManagedForProperties: async () => s.managed }));
vi.mock("@/lib/managed-finance/vendor-bills.server", () => ({
  gateAndPostManagedVendorBill: async (_db: unknown, bill: Record<string, unknown>, _n: Date, opts?: { gateOnly?: boolean }) => {
    s.bills.push({ bill, gateOnly: opts?.gateOnly === true });
    if (opts?.gateOnly) return { status: s.gate, expenseId: "e1" };
    return { status: "posted", journalId: "j1", created: true };
  },
}));
vi.mock("@/lib/managed-finance/directory-vendor.server", () => ({
  textUnclaimedDirectoryBalance: async (_db: unknown, i: { directoryId: string }) => { s.texted.push(i.directoryId); return true; },
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: async () => ({ captured: false }) }));
vi.mock("@/lib/work-order-expenses", async (orig) => ({
  ...(await orig<typeof import("@/lib/work-order-expenses")>()),
  readPostedWorkOrderExpenseLines: async () => ({ ok: true, posted: new Set() }),
  createExpensesFromWorkOrder: async () => { s.expenses += 1; return ["exp-1"]; },
}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => undefined }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => [] }));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => undefined }));

import { approveAndPayWorkOrder } from "@/lib/work-order-approve-pay.server";

const WO = "wo-1";
function world(over: { vendorUserId?: string | null; directory?: Record<string, unknown> | null; workOrder?: Record<string, unknown> } = {}): OwnerFakeDb {
  return fakeOwnerDb({
    portal_work_order_records: [{
      id: WO, manager_user_id: "mgr", vendor_user_id: over.vendorUserId ?? null,
      row_data: { id: WO, title: "Leaking faucet", propertyId: "p-1", propertyName: "Maple Court", vendorId: "vendor-abc", vendorName: "Pat Plumbing", vendorCostCents: 35_000, bucket: "scheduled", ...over.workOrder },
    }],
    manager_vendor_records: over.directory === null ? [] : [{ id: "vendor-abc", manager_user_id: "mgr", vendor_user_id: null, ...over.directory }],
    work_order_bids: [],
    vendor_payouts: [],
  }, { rpc: { claim_work_order_vendor_payment: () => { throw new Error("must not claim a payout for a vendor with no account"); } } });
}
const actor = { userId: "mgr", email: "mgr@example.com", isAdmin: false };
const run = (f: OwnerFakeDb) => approveAndPayWorkOrder(f.db as never, actor, { workOrder: { id: WO } as never, category: "plumbing" as never, paymentChannel: "balance" });

beforeEach(() => { s.managed = { workspaceId: "ws-1", policy: {} }; s.bills.length = 0; s.gate = "cleared"; s.texted.length = 0; s.expenses = 0; });

describe("Approve + pay for a directory vendor with no login on a managed workspace", () => {
  it("posts the bill to the directory row, logs the expenses, marks the service paid, and tells the vendor", async () => {
    const f = world();
    const r = await run(f);
    expect(r).toMatchObject({ ok: true });
    const posted = s.bills.find((b) => !b.gateOnly)!;
    expect(posted.bill).toMatchObject({ workspaceId: "ws-1", vendorUserId: null, vendorDirectoryId: "vendor-abc", amountCents: 35_000, sourceType: "work_order", sourceId: WO });
    expect(s.expenses).toBe(1);
    const row = f.rows.portal_work_order_records![0]!.row_data as Record<string, unknown>;
    expect(row).toMatchObject({ automationStatus: "paid", vendorPaymentChannel: "balance", vendorCostCents: 35_000 });
    expect(row.paidAt).toBeTruthy();
    expect(f.rpcCalls.map((c) => c.name)).not.toContain("claim_work_order_vendor_payment");
    expect(f.rpcCalls.map((c) => c.name)).not.toContain("mark_work_order_payment_paid");
    expect(s.texted).toEqual(["vendor-abc"]);
  });

  it("waits for the owner above their repair limit and posts nothing", async () => {
    s.gate = "pending_owner";
    const f = world();
    expect(await run(f)).toMatchObject({ ok: false, status: 409, code: "OWNER_APPROVAL_PENDING" });
    expect(s.bills.filter((b) => !b.gateOnly)).toHaveLength(0);
    expect(s.texted).toEqual([]);
  });

  it("a repeat click posts the same key again (idempotent in the ledger) and stays paid once", async () => {
    const f = world();
    await run(f);
    await run(f);
    const keys = s.bills.filter((b) => !b.gateOnly).map((b) => `${b.bill.sourceType}:${b.bill.sourceId}:${b.bill.amountCents}`);
    expect(new Set(keys).size).toBe(1);
    expect((f.rows.portal_work_order_records![0]!.row_data as Record<string, unknown>).automationStatus).toBe("paid");
  });

  it("refuses when the vendor is not a directory row of this manager that is still unlinked", async () => {
    expect(await run(world({ directory: null }))).toMatchObject({ ok: false, status: 400 });
    expect(await run(world({ directory: { manager_user_id: "someone-else" } }))).toMatchObject({ ok: false, status: 400 });
    expect(await run(world({ directory: { vendor_user_id: "u9" } }))).toMatchObject({ ok: false, status: 400 });
    expect(s.bills).toHaveLength(0);
  });

  it("a self-serve workspace still refuses a vendor with no account", async () => {
    s.managed = null;
    expect(await run(world())).toMatchObject({ ok: false, status: 400 });
    expect(s.bills).toHaveLength(0);
  });
});
