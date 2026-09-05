import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn().mockResolvedValue({ sent: 1 }) }));
vi.mock("@/lib/twilio", () => ({ sendSms: vi.fn().mockResolvedValue({ sent: true }), normalizeE164: (p: string) => p }));
vi.mock("@/lib/work-order-events.server", () => ({
  workOrderEvent: vi.fn().mockResolvedValue({ duplicate: false, delivered: 2, deferred: 0, failed: 0 }),
}));
vi.mock("@/lib/vendor-availability-server", () => ({
  resolveVendorNextAvailableSlot: vi.fn().mockResolvedValue({ iso: "2026-07-16T17:00:00.000Z" }),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { sendPushToUser } from "@/lib/push-notifications.server";
import { workOrderEvent } from "@/lib/work-order-events.server";
import { resolveVendorNextAvailableSlot } from "@/lib/vendor-availability-server";
import { declineDispatch, executeDispatch, prepareDispatch } from "@/lib/work-order-dispatch.server";
import type { WorkOrderRowWithDispatch } from "@/lib/work-order-dispatch";

type WoRec = { id: string; manager_user_id: string | null; row_data: WorkOrderRowWithDispatch };
type VendorRec = { id: string; manager_user_id: string | null; vendor_user_id: string | null; row_data: Record<string, unknown> };

/** Minimal service-role mock covering every table the dispatch pipeline touches,
 * including audit_log dedupe-key uniqueness (second insert -> 23505). */
function mockDb(opts: {
  workOrders: WoRec[];
  vendors?: VendorRec[];
  vendorDispatchSettings?: Record<string, unknown> | null;
}) {
  const workOrders = new Map(opts.workOrders.map((r) => [r.id, r]));
  const vendors = new Map((opts.vendors ?? []).map((r) => [r.id, r]));
  const auditRows: Array<Record<string, unknown>> = [];
  const inboxRows: Array<Record<string, unknown>> = [];

  const db = {
    from(table: string) {
      if (table === "portal_work_order_records") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({ data: workOrders.get(id) ?? null, error: null }),
              order: () => ({
                range: async () => ({
                  data: [...workOrders.values()].map((r) => ({ row_data: r.row_data })),
                  error: null,
                }),
              }),
            }),
          }),
          update: (patch: { row_data?: WorkOrderRowWithDispatch; vendor_user_id?: string | null }) => ({
            eq: async (_c: string, id: string) => {
              const rec = workOrders.get(id);
              if (rec) {
                if (patch.row_data) rec.row_data = patch.row_data;
                if ("vendor_user_id" in patch) (rec as WoRec & { vendor_user_id?: string | null }).vendor_user_id = patch.vendor_user_id;
              }
              return { error: null };
            },
          }),
        };
      }
      if (table === "manager_vendor_records") {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === "id") {
                return { maybeSingle: async () => ({ data: vendors.get(val) ?? null, error: null }) };
              }
              // loadVendorsForMatching own rows: eq(manager_user_id).order().range()
              return {
                order: () => ({
                  range: async () => ({
                    data: [...vendors.values()]
                      .filter((v) => v.manager_user_id === val)
                      .map((v) => ({ row_data: v.row_data })),
                    error: null,
                  }),
                }),
              };
            },
            neq: () => ({
              eq: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
          }),
        };
      }
      if (table === "manager_automation_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.vendorDispatchSettings ? { vendor_dispatch: opts.vendorDispatchSettings } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "audit_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            const key = row.dedupe_key as string | null;
            if (key && auditRows.some((r) => r.dedupe_key === key)) {
              return { error: { code: "23505", message: "duplicate key" } };
            }
            auditRows.push({ ...row });
            return { error: null };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: async (_c: string, key: string) => {
              const row = auditRows.find((r) => r.dedupe_key === key);
              if (row) Object.assign(row, patch);
              return { error: null };
            },
          }),
        };
      }
      if (table === "portal_inbox_thread_records") {
        return {
          // Agent notices append to the manager's existing assistant thread.
          select: () => ({
            eq: (_column: string, id: string) => ({
              maybeSingle: async () => ({ data: inboxRows.findLast((row) => row.id === id) ?? null, error: null }),
            }),
          }),
          upsert: async (row: Record<string, unknown>) => {
            inboxRows.push(row);
            return { error: null };
          },
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { phone: null, sms_from_number: null }, error: null }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db: db as never, workOrders, auditRows, inboxRows };
}

const openResidentRow = (over: Partial<WorkOrderRowWithDispatch> = {}): WorkOrderRowWithDispatch =>
  ({
    id: "REQ-1",
    propertyName: "128 Oak St",
    unit: "4B",
    title: "Leaking sink",
    priority: "High",
    status: "Submitted",
    bucket: "open",
    description: "Water under the kitchen sink",
    scheduled: "",
    cost: "",
    category: "plumbing",
    managerUserId: "mgr-a",
    residentEmail: "res@a.com",
    ...over,
  }) as WorkOrderRowWithDispatch;

const plumberVendor = (over: Partial<VendorRec> = {}): VendorRec => ({
  id: "v-plumb",
  manager_user_id: "mgr-a",
  vendor_user_id: "vendor-user-1",
  row_data: {
    id: "v-plumb",
    name: "Pipes R Us",
    trade: "Plumbing",
    email: "pipes@example.com",
    active: true,
    managerUserId: "mgr-a",
  },
  ...over,
});

const ACTOR = { userId: "mgr-a", email: "a@test.com", fullName: "Manager A" };

describe("prepareDispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is fully dark when the manager has not opted in", async () => {
    const { db, auditRows, workOrders } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: openResidentRow() }],
      vendors: [plumberVendor()],
      vendorDispatchSettings: null,
    });
    await prepareDispatch(db, "REQ-1");
    expect(auditRows).toHaveLength(0);
    expect(workOrders.get("REQ-1")!.row_data.dispatch).toBeUndefined();
  });

  it("proposes the top matched vendor, notifies the manager, and is replay-safe", async () => {
    const { db, auditRows, inboxRows, workOrders } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: openResidentRow() }],
      vendors: [plumberVendor()],
      vendorDispatchSettings: { mode: "approve" },
    });

    await prepareDispatch(db, "REQ-1");
    const dispatch = workOrders.get("REQ-1")!.row_data.dispatch;
    expect(dispatch?.status).toBe("proposed");
    expect(dispatch?.vendorId).toBe("v-plumb");
    expect(dispatch?.candidates.length).toBeGreaterThan(0);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.dedupe_key).toBe("dispatch_prepare:REQ-1");
    expect(inboxRows).toHaveLength(1);
    expect(String((inboxRows[0]!.row_data as { subject: string }).subject)).toContain("Dispatch ready");
    expect(vi.mocked(sendPushToUser)).toHaveBeenCalledTimes(1);

    // Replay (client re-sync) short-circuits on the existing dispatch key.
    await prepareDispatch(db, "REQ-1");
    expect(auditRows).toHaveLength(1);
    expect(inboxRows).toHaveLength(1);
  });

  it("skips manager-initiated, assigned, and non-open work orders", async () => {
    const rows: WoRec[] = [
      { id: "REQ-mgr", manager_user_id: "mgr-a", row_data: openResidentRow({ id: "REQ-mgr", managerInitiated: true }) },
      { id: "REQ-assigned", manager_user_id: "mgr-a", row_data: openResidentRow({ id: "REQ-assigned", vendorId: "v-x" }) },
      { id: "REQ-done", manager_user_id: "mgr-a", row_data: openResidentRow({ id: "REQ-done", bucket: "completed" }) },
    ];
    const { db, auditRows } = mockDb({ workOrders: rows, vendors: [plumberVendor()], vendorDispatchSettings: { mode: "approve" } });
    for (const r of rows) await prepareDispatch(db, r.id);
    expect(auditRows).toHaveLength(0);
  });

  it("auto mode executes the dispatch when guardrails pass", async () => {
    const { db, workOrders, auditRows, inboxRows } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: openResidentRow() }],
      vendors: [plumberVendor()],
      vendorDispatchSettings: { mode: "auto", approvedVendorIds: ["v-plumb"] },
    });
    await prepareDispatch(db, "REQ-1");
    const row = workOrders.get("REQ-1")!.row_data;
    expect(row.dispatch?.status).toBe("auto_dispatched");
    expect(row.dispatch?.decidedBy).toBe("auto");
    expect(row.vendorId).toBe("v-plumb");
    expect(row.bucket).toBe("scheduled");
    expect(auditRows.map((r) => r.action)).toEqual(["dispatch_prepare", "dispatch_execute"]);
    // "Leaking sink" + plumbing trips the emergency keyword copy.
    expect(String((inboxRows.at(-1)!.row_data as { subject: string }).subject)).toContain("Emergency dispatched");
  });

  it("auto mode downgrades to a proposal when the vendor is not on the approved list", async () => {
    const { db, workOrders, inboxRows } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: openResidentRow() }],
      vendors: [plumberVendor()],
      vendorDispatchSettings: { mode: "auto", approvedVendorIds: ["someone-else"] },
    });
    await prepareDispatch(db, "REQ-1");
    const row = workOrders.get("REQ-1")!.row_data;
    expect(row.dispatch?.status).toBe("proposed");
    expect(row.vendorId).toBeUndefined();
    expect(String((inboxRows.at(-1)!.row_data as { subject: string }).subject)).toContain("Dispatch ready");
  });

  it("notifies the manager when no vendor matches instead of proposing", async () => {
    const { db, inboxRows, workOrders } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: openResidentRow({ category: "hvac" }) }],
      vendors: [plumberVendor()],
      vendorDispatchSettings: { mode: "approve" },
    });
    await prepareDispatch(db, "REQ-1");
    expect(workOrders.get("REQ-1")!.row_data.dispatch).toBeUndefined();
    expect(inboxRows).toHaveLength(1);
    expect(String((inboxRows[0]!.row_data as { subject: string }).subject)).toContain("No vendor matched");
  });
});

describe("executeDispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  const proposedRow = () =>
    openResidentRow({
      dispatch: {
        status: "proposed",
        vendorId: "v-plumb",
        vendorName: "Pipes R Us",
        reasoning: "matches Plumbing",
        candidates: [{ vendorId: "v-plumb", vendorName: "Pipes R Us", reason: "matches Plumbing" }],
        guardrails: { approvedList: true, category: true, spendCap: "no_estimate" },
        proposedAtIso: "2026-07-15T00:00:00.000Z",
      },
    });

  it("assigns, books the vendor's next slot, notifies, and blocks a second execute", async () => {
    const { db, workOrders, auditRows } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: proposedRow() }],
      vendors: [plumberVendor()],
    });

    const result = await executeDispatch(db, { workOrderId: "REQ-1", landlordId: "mgr-a", actor: ACTOR, decidedBy: "manager" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheduledIso).toBe("2026-07-16T17:00:00.000Z");

    const row = workOrders.get("REQ-1")!.row_data;
    expect(row.vendorId).toBe("v-plumb");
    expect(row.bucket).toBe("scheduled");
    expect(row.scheduledAtIso).toBe("2026-07-16T17:00:00.000Z");
    expect(row.dispatch?.status).toBe("approved");
    expect(row.dispatch?.decidedBy).toBe("manager");
    expect((workOrders.get("REQ-1") as WoRec & { vendor_user_id?: string }).vendor_user_id).toBe("vendor-user-1");
    // The canonical event delivers one scheduled notice to each audience;
    // dispatch no longer sends duplicate assignment + booked-visit messages.
    expect(vi.mocked(workOrderEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(workOrderEvent).mock.calls[0]![1]).toMatchObject({
      eventId: "REQ-1:scheduled:dispatch_execute:REQ-1",
      event: "scheduled",
      managerUserId: "mgr-a",
      workOrderId: "REQ-1",
      senderUserId: "mgr-a",
      facts: { title: "Leaking sink", vendorName: "Pipes R Us", scheduledFor: expect.any(String) },
      recipients: [
        { audience: "vendor", userId: "vendor-user-1", email: "pipes@example.com" },
        { audience: "resident", email: "res@a.com" },
      ],
    });
    expect(auditRows.some((r) => r.dedupe_key === "dispatch_execute:REQ-1")).toBe(true);

    const second = await executeDispatch(db, { workOrderId: "REQ-1", landlordId: "mgr-a", actor: ACTOR, decidedBy: "manager" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(409);
    expect(vi.mocked(workOrderEvent)).toHaveBeenCalledTimes(1);
  });

  it("assigns without booking when the vendor has no availability", async () => {
    vi.mocked(resolveVendorNextAvailableSlot).mockResolvedValueOnce({ iso: null, reason: "no_availability" });
    const { db, workOrders } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: proposedRow() }],
      vendors: [plumberVendor()],
    });
    const result = await executeDispatch(db, { workOrderId: "REQ-1", landlordId: "mgr-a", actor: ACTOR, decidedBy: "manager" });
    expect(result.ok).toBe(true);
    const row = workOrders.get("REQ-1")!.row_data;
    expect(row.vendorId).toBe("v-plumb");
    expect(row.bucket).toBe("open");
    expect(row.scheduledAtIso).toBeUndefined();
    expect(vi.mocked(workOrderEvent).mock.calls[0]![1]).toMatchObject({ event: "accepted" });
  });

  it("rejects a non-owner landlord (403) without side effects", async () => {
    const { db, workOrders, auditRows } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: proposedRow() }],
      vendors: [plumberVendor()],
    });
    const result = await executeDispatch(db, { workOrderId: "REQ-1", landlordId: "mgr-evil", actor: ACTOR, decidedBy: "manager" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(workOrders.get("REQ-1")!.row_data.vendorId).toBeUndefined();
    expect(auditRows).toHaveLength(0);
  });

  it("rejects when there is no pending proposal (declined or missing)", async () => {
    const declined = proposedRow();
    declined.dispatch = { ...declined.dispatch!, status: "declined" };
    const { db } = mockDb({
      workOrders: [
        { id: "REQ-declined", manager_user_id: "mgr-a", row_data: declined },
        { id: "REQ-plain", manager_user_id: "mgr-a", row_data: openResidentRow({ id: "REQ-plain" }) },
      ],
      vendors: [plumberVendor()],
    });
    for (const id of ["REQ-declined", "REQ-plain"]) {
      const result = await executeDispatch(db, { workOrderId: id, landlordId: "mgr-a", actor: ACTOR, decidedBy: "manager" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(409);
    }
  });

  it("rejects when the proposed vendor no longer belongs to the manager", async () => {
    const { db } = mockDb({
      workOrders: [{ id: "REQ-1", manager_user_id: "mgr-a", row_data: proposedRow() }],
      vendors: [plumberVendor({ manager_user_id: "mgr-b", row_data: { name: "Pipes R Us", sharedWithManagers: false } })],
    });
    const result = await executeDispatch(db, { workOrderId: "REQ-1", landlordId: "mgr-a", actor: ACTOR, decidedBy: "manager" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });
});

describe("declineDispatch", () => {
  it("marks the proposal declined and leaves the work order unassigned", async () => {
    const { db, workOrders } = mockDb({
      workOrders: [
        {
          id: "REQ-1",
          manager_user_id: "mgr-a",
          row_data: openResidentRow({
            dispatch: {
              status: "proposed",
              vendorId: "v-plumb",
              vendorName: "Pipes R Us",
              reasoning: "r",
              candidates: [],
              guardrails: { approvedList: true, category: true, spendCap: "no_estimate" },
              proposedAtIso: "2026-07-15T00:00:00.000Z",
            },
          }),
        },
      ],
      vendors: [plumberVendor()],
    });
    const result = await declineDispatch(db, { workOrderId: "REQ-1", landlordId: "mgr-a", actorUserId: "mgr-a" });
    expect(result.ok).toBe(true);
    const row = workOrders.get("REQ-1")!.row_data;
    expect(row.dispatch?.status).toBe("declined");
    expect(row.vendorId).toBeUndefined();

    const again = await declineDispatch(db, { workOrderId: "REQ-1", landlordId: "mgr-a", actorUserId: "mgr-a" });
    expect(again.ok).toBe(false);
  });
});
