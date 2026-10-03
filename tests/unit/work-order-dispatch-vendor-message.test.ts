/**
 * comms-safety-0929: one-tap / auto dispatch already tells the vendor
 * ("accepted", or "scheduled" when a slot is booked). The new "You were
 * assigned" message must NOT also go, or the vendor gets two texts for one job.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { workOrderEvent, emitVendorAssigned, resolveSlot } = vi.hoisted(() => ({
  workOrderEvent: vi.fn(),
  emitVendorAssigned: vi.fn(),
  resolveSlot: vi.fn(),
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

function makeDb() {
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
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      update: () => q,
      maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      insert: async () => ({ error: null }),
      then: (resolve: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const run = () =>
  executeDispatch(makeDb(), {
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
