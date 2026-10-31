/**
 * The resident half of SMS dispatch completion, in the two states the release left open.
 *
 * 1. `resolve_resident_dispatch_confirmation` computes the seven-day window but applies the verdict
 *    regardless — it only decides whether to STAMP respondedAt. The migrations are frozen, so the
 *    caller has to enforce the window, or a month-old "no" still strips the completion, writes
 *    `reopenedAt` and alerts the manager, against that migration's own comment.
 * 2. A run parked with no prepared confirmation link was reported as permanently stuck. It is not —
 *    the resident is asked by text and their reply releases it — so that half was not applied, and
 *    the last case here pins the behaviour that makes the report wrong.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  emitConfirmation: vi.fn(async () => undefined),
  notifyOutcome: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  loadVendorContacts: vi.fn(async () => new Map()),
  sendResident: vi.fn(async () => undefined),
  sendVendor: vi.fn(async () => undefined),
  loadRun: vi.fn(),
  workOrderEvent: vi.fn(async () => undefined),
  dispatchOpen: vi.fn(async () => true),
  ensureInvoice: vi.fn(async () => undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/work-order-resident-confirmation.server", () => ({
  prepareResidentConfirmation: mocks.prepare,
  emitResidentConfirmationEvent: mocks.emitConfirmation,
}));
vi.mock("@/lib/vendor-dispatch/engine.server", () => ({
  canActorApprove: vi.fn(),
  loadAttempts: vi.fn(),
  loadRun: mocks.loadRun,
  loadVendorContacts: mocks.loadVendorContacts,
  notifyApprovers: vi.fn(),
  notifyOutcome: mocks.notifyOutcome,
}));
vi.mock("@/lib/vendor-dispatch/audit.server", () => ({ recordDispatchEvent: mocks.recordEvent }));
vi.mock("@/lib/vendor-dispatch/send.server", () => ({
  sendResidentDispatchText: mocks.sendResident,
  sendVendorDispatchText: mocks.sendVendor,
}));
vi.mock("@/lib/vendor-dispatch/work-order-open.server", () => ({
  dispatchWorkOrderIsOpen: mocks.dispatchOpen,
  isTerminalService: () => false,
}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: mocks.workOrderEvent }));
vi.mock("@/lib/work-order-vendor-invoice.server", () => ({ ensureSubmittedVendorInvoiceForMarkedDone: mocks.ensureInvoice }));
vi.mock("@/lib/sms/sms-test-provenance.server", () => ({
  currentSmsTestProvenance: () => null,
  stampSmsTestProvenance: (row: unknown) => row,
}));
vi.mock("@/lib/vendor-invoice-decision-notify.server", () => ({ notifyVendorOfInvoiceDecision: vi.fn() }));
vi.mock("@/lib/manager-bills.server", () => ({ createBillFromVendorInvoice: vi.fn() }));
vi.mock("@/lib/reports/auth", () => ({ assertFinancialsTier: vi.fn() }));
vi.mock("@/lib/vendor-invoice-submit.server", () => ({ insertVendorInvoiceRow: vi.fn(), prepareVendorInvoiceSubmission: vi.fn() }));
vi.mock("@/lib/vendor-dispatch/invoice-managed.server", () => ({ applyApprovedDispatchInvoice: vi.fn(), setServiceVendorCost: vi.fn() }));

import { handleResidentFixedReply } from "@/lib/vendor-dispatch/completion.server";

const OWNER = "owner-1";
const RESIDENT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-30T12:00:00.000Z");

type Row = Record<string, unknown>;

/** Enough of the builder for the two tables these two functions touch. */
function fakeDb(opts: {
  runs?: Row[];
  workOrder?: Row | null;
  attempt?: Row | null;
  rpc?: (fn: string, args: Row) => unknown;
  onRunUpdate?: (patch: Row, filters: Row) => void;
}) {
  const runs = (opts.runs ?? []).map((r) => ({ ...r }));
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const table = (name: string) => {
    const filters: Row = {};
    let patch: Row | null = null;
    const q: Record<string, unknown> = {
      select: () => q,
      update: (value: Row) => ((patch = value), q),
      eq: (column: string, value: unknown) => ((filters[column] = value), q),
      order: () => q,
      limit: async () => ({ data: rowsFor(name), error: null }),
      maybeSingle: async () => ({ data: (rowsFor(name)[0] as Row | undefined) ?? null, error: null }),
    };
    const rowsFor = (t: string): Row[] => {
      if (t === "vendor_dispatch_runs") {
        const hit = runs.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        if (patch) {
          opts.onRunUpdate?.(patch, filters);
          for (const r of hit) Object.assign(r, patch);
          return hit.map((r) => ({ id: r.id }));
        }
        return hit;
      }
      if (t === "portal_work_order_records") return opts.workOrder ? [opts.workOrder] : [];
      if (t === "vendor_dispatch_attempts") return opts.attempt ? [opts.attempt] : [];
      if (t === "profiles") return [{ email: "manager@example.test", full_name: "Mo Manager" }];
      return [];
    };
    // `.select("id")` after an update returns an array, not maybeSingle.
    (q as { select: (cols?: string) => unknown }).select = (cols?: string) => {
      if (patch && cols) return Promise.resolve({ data: rowsFor(name), error: null });
      return q;
    };
    return q;
  };
  return {
    runs,
    rpcCalls,
    from: (name: string) => table(name),
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      return { data: opts.rpc?.(fn, args) ?? null, error: null };
    },
  };
}

const parkedRun = (patch: Row = {}): Row => ({
  id: "run-1",
  owner_user_id: OWNER,
  workspace_id: "ws-1",
  handle: "A1",
  source_type: "work_order",
  source_id: "wo-1",
  status: "accepted",
  completion_state: "awaiting_resident",
  resident_email: "resident@example.test",
  accepted_vendor_directory_id: "dir-1",
  agreed_cents: null,
  approved_by: OWNER,
  details: { houseLabel: "5257 Brooklyn" },
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  vendor_done_at: "2026-10-01T00:00:00.000Z",
  ...patch,
});

beforeEach(() => {
  for (const fn of Object.values(mocks)) if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
  mocks.dispatchOpen.mockResolvedValue(true);
  mocks.loadVendorContacts.mockResolvedValue(new Map());
});

describe("handleResidentFixedReply enforces the seven-day window before the RPC", () => {
  it("applies a reply inside the window", async () => {
    const db = fakeDb({
      runs: [parkedRun({ vendor_done_at: "2026-10-28T00:00:00.000Z" })],
      workOrder: { id: "wo-1", manager_user_id: OWNER, resident_user_id: RESIDENT, row_revision: 3, row_data: { id: "wo-1" } },
      rpc: () => ({ applied: true, confirmation_applied: false }),
    });

    const outcome = await handleResidentFixedReply(db as never, {
      ownerUserId: OWNER, residentUserId: RESIDENT, residentEmail: "resident@example.test",
      verdict: "not_fixed", now: NOW,
    });

    expect(outcome).toMatchObject({ handled: true });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["resolve_resident_dispatch_confirmation"]);
  });

  it("refuses a month-old reply without calling the RPC at all", async () => {
    const db = fakeDb({
      runs: [parkedRun({ vendor_done_at: "2026-09-15T00:00:00.000Z" })],
      rpc: () => ({ applied: true }),
    });

    const outcome = await handleResidentFixedReply(db as never, {
      ownerUserId: OWNER, residentUserId: RESIDENT, residentEmail: "resident@example.test",
      verdict: "not_fixed", now: NOW,
    });

    expect(db.rpcCalls).toEqual([]);
    expect(outcome).toMatchObject({ handled: true });
    expect((outcome as { reply: string }).reply).toMatch(/too old to update by text/i);
    // No state moved: the run is untouched and the manager was not alerted.
    expect(db.runs[0]!.completion_state).toBe("awaiting_resident");
    expect(mocks.notifyOutcome).not.toHaveBeenCalled();
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it("refuses a run whose asked-at timestamp cannot be read", async () => {
    const db = fakeDb({
      runs: [parkedRun({ vendor_done_at: null, updated_at: "not a date", created_at: "also not a date" })],
      rpc: () => ({ applied: true }),
    });

    const outcome = await handleResidentFixedReply(db as never, {
      ownerUserId: OWNER, residentUserId: RESIDENT, residentEmail: "resident@example.test",
      verdict: "fixed", now: NOW,
    });

    expect(db.rpcCalls).toEqual([]);
    expect(outcome).toMatchObject({ handled: true });
  });

  it("leaves an ordinary YES to the resident agent when there is no parked run", async () => {
    const db = fakeDb({ runs: [] });
    await expect(
      handleResidentFixedReply(db as never, {
        ownerUserId: OWNER, residentUserId: RESIDENT, residentEmail: "resident@example.test",
        verdict: "fixed", now: NOW,
      }),
    ).resolves.toEqual({ handled: false });
  });
});

/**
 * The parking half of the original finding was NOT applied, and this records why.
 *
 * `prepareResidentConfirmation` gates only the signed LINK — the manager's email-confirmation step.
 * The resident is asked by TEXT either way (`composeResidentFixedAsk`), and
 * `resolve_resident_dispatch_confirmation` applies their YES / NO whether or not a
 * `residentConfirmation` was ever stamped, so a parked run is releasable with no digest.
 * `vendor-dispatch-engine.test.ts` pins exactly that end to end with
 * `prepareResidentConfirmation` mocked to null. Withholding `p_resident` would also be refused by
 * the frozen RPC ("stale"), which pins it against the row's own subject.
 */
describe("a parked run with no prepared link is still releasable by the resident's text", () => {
  it("applies the verdict even when the RPC reports confirmation_applied false", async () => {
    const db = fakeDb({
      runs: [parkedRun({ vendor_done_at: "2026-10-29T00:00:00.000Z" })],
      workOrder: { id: "wo-1", manager_user_id: OWNER, resident_user_id: RESIDENT, row_revision: 3, row_data: { id: "wo-1" } },
      // No residentConfirmation on the row: nothing was stamped, the verdict still lands.
      rpc: () => ({ applied: true, confirmation_applied: false }),
    });

    const outcome = await handleResidentFixedReply(db as never, {
      ownerUserId: OWNER, residentUserId: RESIDENT, residentEmail: "resident@example.test",
      verdict: "fixed", now: NOW,
    });

    expect(outcome).toMatchObject({ handled: true });
    expect((outcome as { reply: string }).reply).toMatch(/glad it is fixed/i);
    expect(db.rpcCalls[0]!.args.p_resident).toBe(RESIDENT);
  });
});
