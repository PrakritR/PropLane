import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Schedule visit can hand a maintenance visit to the manager, a co-manager, or
 * a vendor. Whoever takes it must be the task's assignee, the row must carry the
 * same answer in the shared `assignee` shape, and the legacy `vendorId` /
 * `selfAssigned` pair must keep saying what the vendor portal expects.
 */

const updateManagerWorkOrder = vi.fn();
const createScheduledWorkTask = vi.fn(async () => undefined);

vi.mock("@/lib/manager-work-orders-storage", () => ({
  updateManagerWorkOrder: (...args: unknown[]) => updateManagerWorkOrder(...args),
}));
vi.mock("@/lib/manager-scheduled-work-tasks", () => ({
  createScheduledWorkTask: (...args: unknown[]) => createScheduledWorkTask(...args),
  scheduledTaskTitleForWorkOrder: (t: string) => `Service · ${t}`,
}));
vi.mock("@/lib/manager-vendors-storage", () => ({
  readActiveManagerVendorRows: () => [
    { id: "v-apex", name: "Apex Plumbing", trade: "Plumbing", email: "", phone: "", active: true },
  ],
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => true }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
vi.mock("@/lib/portal-message-delivery", () => ({ deliverPortalInboxMessage: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/work-order-resident-notifications", () => ({
  notifyResidentOfWorkOrderUpdate: vi.fn(async () => ({ ok: true })),
}));

import { scheduleServiceVisit } from "@/lib/schedule-service-visit";

const ROW = {
  id: "wo-1",
  title: "Kitchen faucet drip",
  propertyName: "The Pioneer",
  propertyId: "p-1",
  unit: "Room 8B",
  bucket: "open",
  status: "Open",
  description: "Drips overnight",
} as never;

function writtenRow() {
  const updater = updateManagerWorkOrder.mock.calls.at(-1)?.[1] as (r: unknown) => Record<string, unknown>;
  return updater(ROW);
}

function taskInput() {
  return createScheduledWorkTask.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  updateManagerWorkOrder.mockClear();
  createScheduledWorkTask.mockClear();
});

describe("scheduleServiceVisit assignee", () => {
  it("self: the manager's own task, no vendor on the row", async () => {
    const r = await scheduleServiceVisit({
      managerUserId: "mgr-1",
      managerName: "Test Manager",
      row: ROW,
      visitAtIso: "2026-09-14T17:00:00.000Z",
      assignee: { kind: "self" },
    });
    expect(r.ok).toBe(true);
    const row = writtenRow();
    expect(row.selfAssigned).toBe(true);
    expect(row.vendorId).toBeUndefined();
    expect(row.assignee).toEqual({ type: "team", id: "mgr-1", name: "Test Manager" });
    expect(taskInput().assignee).toEqual({ type: "team", id: "mgr-1", name: "Test Manager" });
    expect(row.bucket).toBe("scheduled");
  });

  it("co-manager: the task goes to their id; the row still reads as team-held", async () => {
    await scheduleServiceVisit({
      managerUserId: "mgr-1",
      row: ROW,
      visitAtIso: "2026-09-14T17:00:00.000Z",
      assignee: { kind: "team", userId: "mgr-2", name: "Akhil" },
    });
    const row = writtenRow();
    expect(row.selfAssigned).toBe(true);
    expect(row.vendorId).toBeUndefined();
    expect(row.assignee).toEqual({ type: "team", id: "mgr-2", name: "Akhil" });
    expect(taskInput().assignee).toEqual({ type: "team", id: "mgr-2", name: "Akhil" });
  });

  it("vendor: legacy vendorId is written beside the shared assignee, task goes to the vendor", async () => {
    await scheduleServiceVisit({
      managerUserId: "mgr-1",
      row: ROW,
      visitAtIso: "2026-09-14T17:00:00.000Z",
      durationMinutes: 90,
      assignee: { kind: "vendor", vendorId: "v-apex" },
    });
    const row = writtenRow();
    expect(row.selfAssigned).toBe(false);
    expect(row.vendorId).toBe("v-apex");
    expect(row.vendorName).toBe("Apex Plumbing");
    expect(row.assignee).toEqual({ type: "vendor", id: "v-apex", name: "Apex Plumbing" });
    const task = taskInput();
    expect(task.assignee).toEqual({ type: "vendor", id: "v-apex", name: "Apex Plumbing" });
    expect(task.end).toBe("2026-09-14T18:30:00.000Z");
  });

  it("refuses an unknown vendor without touching the row", async () => {
    const r = await scheduleServiceVisit({
      managerUserId: "mgr-1",
      row: ROW,
      visitAtIso: "2026-09-14T17:00:00.000Z",
      assignee: { kind: "vendor", vendorId: "nope" },
    });
    expect(r.ok).toBe(false);
    expect(updateManagerWorkOrder).not.toHaveBeenCalled();
  });
});
