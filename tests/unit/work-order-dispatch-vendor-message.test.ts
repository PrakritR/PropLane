/**
 * comms-safety-0929: one-tap / auto dispatch already tells the vendor
 * ("accepted", or "scheduled" when a slot is booked). The new "You were
 * assigned" message must NOT also go, or the vendor gets two texts for one job.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { workOrderEvent, emitVendorAssigned, resolveSlot, databaseWrites } = vi.hoisted(() => ({
  workOrderEvent: vi.fn(),
  emitVendorAssigned: vi.fn(),
  resolveSlot: vi.fn(),
  databaseWrites: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: (...a: unknown[]) => workOrderEvent(...a) }));
vi.mock("@/lib/work-order-vendor-messages.server", () => ({ emitVendorAssigned: (...a: unknown[]) => emitVendorAssigned(...a) }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: vi.fn() }));
vi.mock("@/lib/agent/vendor-agent.server", () => ({ ensureVendorAgentSession: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncWorkOrderToGoogleCalendar: async (_d: unknown, _m: unknown, row: unknown) => row }));
vi.mock("@/lib/vendor-availability-server", () => ({ resolveVendorNextAvailableSlot: (...a: unknown[]) => resolveSlot(...a) }));
vi.mock("@/lib/vendor-dispatch-settings", () => ({ loadVendorDispatchSettings: async () => ({ mode: "approve", agentMessagingEnabled: false }) }));
vi.mock("@/lib/tools/domains/work-orders", () => ({ loadManagerWorkOrders: vi.fn(), loadVendorsForMatching: vi.fn() }));

import { executeDispatch } from "@/lib/work-order-dispatch.server";

function makeDb(options: { coordinationStatus?: string; sourcingState?: string; coordinationError?: boolean } = {}) {
  const rows: Record<string, Record<string, unknown> | null> = {
    portal_work_order_records: {
      id: "wo-1",
      manager_user_id: "mgr-1",
      row_data: {
        id: "wo-1",
        reference: "SRV-1",
        title: "Leaking sink",
        propertyName: "5257 Brooklyn Ave NE",
        residentEmail: "alex@resident.test",
        dispatch: { status: "proposed", vendorId: "vd-1", vendorName: "North Plumbing", reasoning: "", candidates: [], guardrails: {}, proposedAtIso: "2026-09-29T09:00:00.000Z" },
      },
    },
    manager_vendor_records: {
      id: "vd-1",
      manager_user_id: "mgr-1",
      vendor_user_id: "vendor-user-1",
      row_data: { name: "North Plumbing", email: "north@vendor.test" },
    },
  };
  const from = (table: string) => {
    let records: Array<Record<string, unknown>> = table === "vendor_coordination_proposals"
      ? options.coordinationStatus ? [{ id: "proposal-1", work_order_id: "wo-1", status: options.coordinationStatus }] : []
      : table === "vendor_sourcing_jobs" ? options.sourcingState ? [{ work_order_id: "wo-1", state: options.sourcingState }] : []
      : rows[table] ? [rows[table]!] : [];
    const error = table === "vendor_coordination_proposals" && options.coordinationError ? { message: "unavailable" } : null;
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (column: string, value: unknown) => { records = records.filter((r) => r[column] === value); return q; },
      in: (column: string, values: unknown[]) => { records = records.filter((r) => values.includes(r[column])); return q; },
      limit: (count: number) => { records = records.slice(0, count); return q; },
      update: (values: unknown) => { databaseWrites(table, values); return q; },
      maybeSingle: async () => ({ data: records[0] ?? null, error }),
      insert: async (values: unknown) => { databaseWrites(table, values); return { error: null }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: records, error }).then(resolve),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const run = (options: Parameters<typeof makeDb>[0] = {}) =>
  executeDispatch(makeDb(options), {
    workOrderId: "wo-1",
    landlordId: "mgr-1",
    actor: { userId: "mgr-1", email: "mgr@seattle.test", fullName: "Manager" },
    decidedBy: "manager",
  });

beforeEach(() => {
  vi.clearAllMocks();
  workOrderEvent.mockResolvedValue({ eventId: "x", duplicate: false, delivered: 1, deferred: 0, failed: 0 });
});

describe("executeDispatch vendor messaging", () => {
  it.each(["collecting", "ready", "approved"])("refuses legacy dispatch for an active %s coordination proposal without assigning or messaging", async (coordinationStatus) => {
    expect(await run({ coordinationStatus })).toMatchObject({ ok: false, status: 409 });
    expect(databaseWrites).not.toHaveBeenCalled(); expect(resolveSlot).not.toHaveBeenCalled(); expect(workOrderEvent).not.toHaveBeenCalled(); expect(emitVendorAssigned).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "declined"])("does not block ordinary dispatch for a terminal %s proposal", async (coordinationStatus) => {
    resolveSlot.mockResolvedValue({ iso: null });
    expect((await run({ coordinationStatus })).ok).toBe(true);
    expect(workOrderEvent.mock.calls.map((call) => (call[1] as { event: string }).event)).toEqual(["accepted"]);
    expect(emitVendorAssigned).not.toHaveBeenCalled();
  });

  it("fails closed when coordination enrollment cannot be checked", async () => {
    await expect(run({ coordinationError: true })).rejects.toThrow("Coordination state unavailable");
    expect(databaseWrites).not.toHaveBeenCalled(); expect(workOrderEvent).not.toHaveBeenCalled();
  });

  it("refuses active sourcing before booking or messaging", async () => {
    expect(await run({ sourcingState: "waiting" })).toMatchObject({ ok: false, status: 409 });
    expect(databaseWrites).not.toHaveBeenCalled(); expect(resolveSlot).not.toHaveBeenCalled(); expect(workOrderEvent).not.toHaveBeenCalled();
  });

  it("with no slot: the vendor hears 'accepted' once, and never 'assigned'", async () => {
    resolveSlot.mockResolvedValue({ iso: null });
    const result = await run();
    expect(result.ok).toBe(true);
    const events = workOrderEvent.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toEqual(["accepted"]);
    expect(emitVendorAssigned).not.toHaveBeenCalled();
  });

  it("with a booked slot: the vendor hears 'scheduled' once, and never 'assigned'", async () => {
    resolveSlot.mockResolvedValue({ iso: "2026-09-30T17:00:00.000Z" });
    await run();
    const events = workOrderEvent.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toEqual(["scheduled"]);
    const call = workOrderEvent.mock.calls[0]![1] as { recipients: Array<{ audience: string }> };
    expect(call.recipients.filter((r) => r.audience === "vendor")).toHaveLength(1);
    expect(emitVendorAssigned).not.toHaveBeenCalled();
  });
});
