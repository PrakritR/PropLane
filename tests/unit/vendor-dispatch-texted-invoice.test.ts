import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatchDb } from "./support/dispatch-memory-db";

/**
 * A vendor texting "INVOICE $240", and the manager's Y on it. Two defects this pins:
 *   - the run was claimed AFTER the invoice row was inserted, so two quick texts both filed a submitted
 *     invoice and the loser's row stayed live on the vendor-invoice rails, approvable as a second bill;
 *   - approval flipped the invoice to `approved` before the bill was created, so a transient failure left
 *     the invoice approved with no bill and no way back ("#1 is already handled").
 */
const state = vi.hoisted(() => ({
  invoices: [] as Array<Record<string, unknown>>,
  nextId: 0,
  billFails: false,
  billCalls: 0,
}));

vi.mock("@/lib/vendor-dispatch/send.server", () => ({
  workspaceOnSharedLine: async () => false,
  sendVendorDispatchText: async () => ({ ok: true, outboxId: null }),
  sendTeamMemberDispatchText: async () => ({ ok: true, outboxId: null }),
  sendResidentDispatchText: async () => ({ ok: true, outboxId: null }),
}));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  readVendorTextConsent: async () => ({ ok: true, state: "granted", conversationKey: "k", grantedUnder: "k", grantSource: "t" }),
}));
vi.mock("@/lib/team-comms.server", () => ({
  resolveWorkspaceTeamMembersWithGrants: async (_db: unknown, input: { ownerManagerUserId: string }) => [
    { userId: input.ownerManagerUserId, teamRole: null, isOwner: true, grantRow: null },
  ],
}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => ({ eventId: "e", duplicate: false, delivered: 0, deferred: 0, failed: 0 }) }));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncWorkOrderToGoogleCalendar: async (_db: unknown, _o: string, row: unknown) => row }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async () => undefined }));
vi.mock("@/lib/work-order-resident-confirmation.server", () => ({ requestResidentConfirmation: async () => null, resolveResidentConfirmationBySms: async () => null }));
vi.mock("@/lib/work-order-vendor-invoice.server", () => ({ ensureSubmittedVendorInvoiceForMarkedDone: async () => undefined }));
vi.mock("@/lib/vendor-invoice-decision-notify.server", () => ({ notifyVendorOfInvoiceDecision: async () => undefined }));
vi.mock("@/lib/reports/auth", () => ({ assertFinancialsTier: async () => ({ ok: true }) }));
vi.mock("@/lib/agent/portal-assistant-session.server", () => ({ readPortalAssistantSmsSession: async () => ({ ok: true, session: null }) }));
vi.mock("@/lib/sms/agent-confirmation.server", () => ({ classifySmsConfirmationReply: () => "none", resolveOpenSmsProposal: async () => ({ status: "none" }) }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ userDefaultWorkspaceId: async () => "ws-1" }));

// The vendor-invoice rails, in memory: every insert is a live submitted invoice a manager could approve later.
vi.mock("@/lib/vendor-invoice-submit.server", () => ({
  prepareVendorInvoiceSubmission: async () => ({ totalCents: 24_000 }),
  insertVendorInvoiceRow: async () => {
    state.nextId += 1;
    const row = { id: `inv-${state.nextId}`, status: "submitted", manager_user_id: "owner-1", vendor_user_id: "vu-1", total_cents: 24_000, work_order_id: "wo-1" };
    state.invoices.push(row);
    return { data: row };
  },
}));
vi.mock("@/lib/manager-bills.server", () => ({
  createBillFromVendorInvoice: async () => {
    state.billCalls += 1;
    if (state.billFails) throw new Error("transient");
    return { id: "bill-1" };
  },
}));

import { approveDispatchRun, createDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import { recordVendorYes } from "@/lib/vendor-dispatch/responses.server";
import { decideRunInvoice, recordVendorInvoice } from "@/lib/vendor-dispatch/completion.server";

const OWNER = "owner-1";
const WS = "ws-1";
const PROP = "prop-1";
const T0 = new Date("2026-10-19T20:00:00Z");

function world() {
  const db = createDispatchDb({
    manager_property_records: [{ id: PROP, manager_user_id: OWNER, workspace_id: WS, property_data: { address: "5259 Brooklyn Ave NE", title: "5259 Brooklyn" } }],
    manager_vendor_records: [{
      id: "v1", manager_user_id: OWNER, vendor_user_id: "vu-1",
      row_data: { id: "v1", name: "Sam Locksmith", trade: "Locksmith", trades: ["Locksmith"], phone: "(206) 555-0101", email: "", notes: "", active: true },
    }],
    vendor_dispatch_rules: [],
    vendor_dispatch_rule_vendors: [],
    portal_work_order_records: [{ id: "wo-1", manager_user_id: OWNER, vendor_user_id: null, row_data: { id: "wo-1", propertyId: PROP, managerUserId: OWNER, title: "Locked out", bucket: "open", status: "Submitted" } }],
    vendor_invoices: [],
    profiles: [{ id: OWNER, email: "owner@example.com", full_name: "Olive Owner" }],
  });
  // The dispatch rails hold the invoice rows this flow can later decide on.
  (db.__tables as Record<string, Record<string, unknown>[]>).vendor_invoices = state.invoices;
  return db;
}

async function acceptedRun(db: ReturnType<typeof world>) {
  const created = await createDispatchRun(db as never, {
    workspaceId: WS, ownerUserId: OWNER, sourceType: "work_order", sourceId: "wo-1", trade: "locksmith",
    issue: "lockout", urgency: "emergency", propertyId: PROP, residentEmail: "dana@example.com", createdBy: null,
    at: T0, details: { what: "Lockout" }, vendorDirectoryIds: ["v1"],
  } as never);
  if (!created.ok) throw new Error(`run not created: ${created.reason}`);
  await approveDispatchRun(db as never, { ownerUserId: OWNER, actorUserId: OWNER, channel: "sms", runId: created.run.id, now: T0 });
  const attempt = (db.__tables.vendor_dispatch_attempts ?? []).find((a) => a.run_id === created.run.id)!;
  await recordVendorYes(db as never, { ownerUserId: OWNER, attemptId: String(attempt.id), timeText: "2:30pm", now: T0 });
  return { runId: created.run.id, attemptId: String(attempt.id) };
}

beforeEach(() => {
  state.invoices.length = 0;
  state.nextId = 0;
  state.billFails = false;
  state.billCalls = 0;
});

describe("a texted invoice files exactly one row", () => {
  it("two INVOICE texts in quick succession leave one submitted invoice, not an orphan", async () => {
    const db = world();
    const { runId, attemptId } = await acceptedRun(db);

    const [first, second] = await Promise.all([
      recordVendorInvoice(db as never, { ownerUserId: OWNER, attemptId, amountCents: 24_000, now: T0 }),
      recordVendorInvoice(db as never, { ownerUserId: OWNER, attemptId, amountCents: 24_000, now: T0 }),
    ]);
    expect([first, second].sort()).toEqual(["already_pending", "asked"]);
    expect(state.invoices).toHaveLength(1);

    const run = (db.__tables.vendor_dispatch_runs ?? []).find((r) => r.id === runId)!;
    expect(run.pending_invoice_cents).toBe(24_000);
    expect((run.details as { invoiceId?: string }).invoiceId).toBe(state.invoices[0]!.id);
  });
});

describe("the manager's Y on a texted invoice", () => {
  it("creates the bill and clears the run", async () => {
    const db = world();
    const { runId, attemptId } = await acceptedRun(db);
    await recordVendorInvoice(db as never, { ownerUserId: OWNER, attemptId, amountCents: 24_000, now: T0 });

    expect(await decideRunInvoice(db as never, { ownerUserId: OWNER, actorUserId: OWNER, runId, approve: true, now: T0 })).toEqual({ ok: true });
    expect(state.billCalls).toBe(1);
    expect(state.invoices[0]!.status).toBe("approved");
    expect((db.__tables.vendor_dispatch_runs ?? []).find((r) => r.id === runId)!.pending_invoice_cents).toBeNull();
  });

  it("puts the invoice back to submitted when bill creation fails, so the next Y still works", async () => {
    const db = world();
    const { runId, attemptId } = await acceptedRun(db);
    await recordVendorInvoice(db as never, { ownerUserId: OWNER, attemptId, amountCents: 24_000, now: T0 });

    state.billFails = true;
    expect(await decideRunInvoice(db as never, { ownerUserId: OWNER, actorUserId: OWNER, runId, approve: true, now: T0 }))
      .toEqual({ ok: false, reason: "unavailable" });
    // Not left approved-with-no-bill: the state is recoverable by text.
    expect(state.invoices[0]!.status).toBe("submitted");
    expect((db.__tables.vendor_dispatch_runs ?? []).find((r) => r.id === runId)!.pending_invoice_cents).toBe(24_000);

    state.billFails = false;
    expect(await decideRunInvoice(db as never, { ownerUserId: OWNER, actorUserId: OWNER, runId, approve: true, now: T0 })).toEqual({ ok: true });
    expect(state.invoices[0]!.status).toBe("approved");
  });
});
