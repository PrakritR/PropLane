/** decideRunInvoice: Y on a texted invoice approves it, sets the service cost from the invoice, and settles per workspace type. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb } from "../helpers/owner-fake-db";

const state = vi.hoisted(() => ({
  run: null as Record<string, unknown> | null,
  settled: "not_managed" as string,
  applied: [] as Array<Record<string, unknown>>,
  costs: [] as number[],
  texted: [] as string[],
  applyThrows: false,
  contact: { id: "vendor-abc", name: "Pat Plumbing", vendorUserId: "ven-1" } as { id: string; name: string; vendorUserId: string | null },
  bills: 0,
}));

vi.mock("@/lib/vendor-dispatch/engine.server", () => ({
  loadRun: async () => state.run,
  loadAttempts: async () => [],
  canActorApprove: async () => true,
  loadVendorContacts: async (_db: unknown, _owner: string, ids: string[]) => new Map(ids.map((id) => [id, state.contact])),
  notifyApprovers: async () => undefined,
  notifyOutcome: async () => undefined,
}));
vi.mock("@/lib/vendor-dispatch/invoice-managed.server", () => ({
  setServiceVendorCost: async (_db: unknown, _run: unknown, cents: number) => { state.costs.push(cents); return true; },
  applyApprovedDispatchInvoice: async (_db: unknown, input: Record<string, unknown>) => {
    if (state.applyThrows) throw new Error("ledger unavailable");
    state.applied.push(input);
    return state.settled;
  },
}));
vi.mock("@/lib/managed-finance/directory-vendor.server", () => ({
  textUnclaimedDirectoryBalance: async (_db: unknown, input: { directoryId: string }) => { state.texted.push(input.directoryId); return true; },
}));
vi.mock("@/lib/manager-bills.server", () => ({ createBillFromVendorInvoice: async () => { state.bills += 1; } }));
vi.mock("@/lib/reports/auth", () => ({ assertFinancialsTier: async () => ({ ok: true }) }));
vi.mock("@/lib/vendor-invoice-decision-notify.server", () => ({ notifyVendorOfInvoiceDecision: async () => undefined }));
vi.mock("@/lib/vendor-dispatch/audit.server", () => ({ recordDispatchEvent: async () => undefined }));
vi.mock("@/lib/vendor-dispatch/send.server", () => ({ sendResidentDispatchText: async () => ({ ok: true }), sendVendorDispatchText: async () => ({ ok: true }) }));

import { decideRunInvoice } from "@/lib/vendor-dispatch/completion.server";

const baseRun = () => ({
  id: "run-1", owner_user_id: "mgr", workspace_id: "ws-1", handle: 7, source_type: "work_order", source_id: "wo-1", property_id: "p-1",
  status: "accepted", pending_invoice_cents: 30_000, accepted_vendor_directory_id: "vendor-abc", details: { what: "Faucet", invoiceId: "inv-1" },
});
const db = () => fakeOwnerDb({
  vendor_invoices: [{ id: "inv-1", manager_user_id: "mgr", vendor_user_id: "ven-1", status: "submitted", total_cents: 35_000, work_order_id: "wo-1" }],
  vendor_dispatch_runs: [baseRun()],
});

beforeEach(() => {
  state.run = baseRun(); state.settled = "not_managed"; state.applied.length = 0; state.costs.length = 0; state.texted.length = 0; state.bills = 0;
  state.applyThrows = false;
  state.contact = { id: "vendor-abc", name: "Pat Plumbing", vendorUserId: "ven-1" };
});

const decide = (f: ReturnType<typeof db>, approve: boolean) =>
  decideRunInvoice(f.db, { ownerUserId: "mgr", actorUserId: "mgr", runId: "run-1", approve, now: new Date("2026-10-19T18:00:00Z") });

describe("Y on a texted invoice", () => {
  it("uses the invoice row's recomputed total, not the texted figure, as the service cost and the managed bill", async () => {
    const f = db();
    expect(await decide(f, true)).toMatchObject({ ok: true, settled: "not_managed" });
    expect(state.costs).toEqual([35_000]);
    expect(state.applied[0]).toMatchObject({ amountCents: 35_000, invoiceId: "inv-1", vendorUserId: "ven-1", vendorDirectoryId: "vendor-abc" });
    expect(state.bills).toBe(1);
    expect(f.rows.vendor_invoices![0]!.status).toBe("approved");
    expect(f.rows.vendor_dispatch_runs![0]!).toMatchObject({ pending_invoice_cents: null, agreed_cents: 35_000 });
  });

  it("a managed workspace over the owner's limit reports that the owner was asked", async () => {
    state.settled = "waiting_owner";
    expect(await decide(db(), true)).toMatchObject({ ok: true, settled: "waiting_owner" });
  });

  it("a vendor with no invoice row (no login) settles on the texted amount and is told money is waiting", async () => {
    state.run = { ...baseRun(), details: { what: "Faucet" } };
    state.contact = { id: "vendor-abc", name: "Pat Plumbing", vendorUserId: null };
    state.settled = "posted";
    const f = fakeOwnerDb({ vendor_dispatch_runs: [baseRun()] });
    expect(await decide(f as never, true)).toMatchObject({ ok: true, settled: "posted" });
    expect(state.costs).toEqual([30_000]);
    expect(state.applied[0]).toMatchObject({ amountCents: 30_000, invoiceId: null, vendorUserId: null, vendorDirectoryId: "vendor-abc" });
    expect(state.texted).toEqual(["vendor-abc"]);
  });

  it("a retried Y on an invoice-less run claims the pending amount once: one post, one 'balance waiting' text", async () => {
    // A roster vendor has no invoice row to claim, so the run's own pending amount is the claim. Without it a
    // webhook retry (or two approvers answering at once) posted the bill, texted the vendor and wrote the audit twice.
    state.run = { ...baseRun(), details: { what: "Faucet" } };
    state.contact = { id: "vendor-abc", name: "Pat Plumbing", vendorUserId: null };
    state.settled = "posted";
    const f = fakeOwnerDb({ vendor_dispatch_runs: [baseRun()] });
    expect(await decide(f as never, true)).toMatchObject({ ok: true, settled: "posted" });
    expect(await decide(f as never, true)).toEqual({ ok: false, reason: "wrong_state" });
    expect(state.applied).toHaveLength(1);
    expect(state.costs).toEqual([30_000]);
    expect(state.texted).toEqual(["vendor-abc"]);
  });

  it("a failed post hands the claim back, so the manager's next Y can approve the same invoice", async () => {
    // Clearing the pending amount before the work ran meant a LedgerError left nothing to approve ever again.
    state.run = { ...baseRun(), details: { what: "Faucet" } };
    state.contact = { id: "vendor-abc", name: "Pat Plumbing", vendorUserId: null };
    state.settled = "posted";
    state.applyThrows = true;
    const f = fakeOwnerDb({ vendor_dispatch_runs: [baseRun()] });
    expect(await decide(f as never, true)).toEqual({ ok: false, reason: "unavailable" });
    expect(f.rows.vendor_dispatch_runs![0]!.pending_invoice_cents).toBe(30_000);
    state.applyThrows = false;
    expect(await decide(f as never, true)).toMatchObject({ ok: true, settled: "posted" });
    expect(state.applied).toHaveLength(1);
  });

  it("a failed post on an invoice row puts the invoice back to submitted", async () => {
    state.settled = "posted";
    state.applyThrows = true;
    const f = db();
    expect(await decide(f, true)).toEqual({ ok: false, reason: "unavailable" });
    expect(f.rows.vendor_invoices![0]!.status).toBe("submitted");
    state.applyThrows = false;
    expect(await decide(f, true)).toMatchObject({ ok: true, settled: "posted" });
  });

  it("a login vendor who is paid is not texted a sign-up link", async () => {
    state.settled = "posted";
    await decide(db(), true);
    expect(state.texted).toEqual([]);
  });

  it("N changes no cost and posts nothing", async () => {
    const f = db();
    expect(await decide(f, false)).toEqual({ ok: true });
    expect(state.costs).toEqual([]);
    expect(state.applied).toEqual([]);
    expect(f.rows.vendor_invoices![0]!.status).toBe("rejected");
  });

  it("a second Y on an already-decided invoice is refused and posts nothing", async () => {
    const f = db();
    await decide(f, true);
    state.applied.length = 0;
    state.run = baseRun();
    expect(await decide(f, true)).toEqual({ ok: false, reason: "wrong_state" });
    expect(state.applied).toEqual([]);
  });
});
