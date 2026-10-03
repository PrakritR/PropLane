/**
 * comms-safety-0929: a task assigned to a vendor tells that vendor
 * ("New task from <manager>"). It is a diff on the assignee, so ticking a task
 * off, saving it unchanged, or assigning a team member sends nothing, and a
 * failed message never fails the save.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { emitVendorTaskAssigned } = vi.hoisted(() => ({ emitVendorTaskAssigned: vi.fn() }));

vi.mock("@/lib/work-order-vendor-messages.server", () => ({
  emitVendorTaskAssigned: (...args: unknown[]) => emitVendorTaskAssigned(...args),
}));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  viewerAndLinkedOwnerIdsForModule: async (_db: unknown, viewer: string) => [viewer],
}));
vi.mock("@/lib/workspaces/active.server", () => ({ resolveActiveWorkspaceFromRequest: async () => ({ propertyIds: [], owned: true, isDefault: true }) }));

import { createManagerTaskRow, patchManagerTaskRow } from "@/lib/manager-tasks.server";

/** One stateful portal_schedule_records row, enough for read-modify-write. */
function makeDb() {
  let stored: Record<string, unknown> | null = null;
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stored, error: null }) }) }),
      upsert: async (row: Record<string, unknown>) => {
        stored = row;
        return { error: null };
      },
    }),
  };
  return db as unknown as SupabaseClient;
}

const vendor = { type: "vendor", id: "vd-1", name: "North Plumbing" };

beforeEach(() => {
  vi.clearAllMocks();
  emitVendorTaskAssigned.mockResolvedValue({ sent: true, duplicate: false });
});

describe("task assigned to a vendor", () => {
  it("creating one messages the vendor once, keyed to the creation time", async () => {
    const task = await createManagerTaskRow(makeDb(), "mgr-1", { title: "Replace smoke detector", assignee: vendor });
    expect(emitVendorTaskAssigned).toHaveBeenCalledTimes(1);
    expect(emitVendorTaskAssigned.mock.calls[0]![1]).toMatchObject({ managerUserId: "mgr-1", changedAt: task.createdAt });
    expect(emitVendorTaskAssigned.mock.calls[0]![1].task).toMatchObject({ id: task.id, assignee: vendor });
  });

  it("a task for a team member sends no vendor message", async () => {
    await createManagerTaskRow(makeDb(), "mgr-1", { title: "Call resident", assignee: { type: "team", id: "mgr-2", name: "Dana" } });
    expect(emitVendorTaskAssigned).not.toHaveBeenCalled();
  });

  it("moving a task onto a vendor messages them; ticking it off, or saving unchanged, does not", async () => {
    const db = makeDb();
    const task = await createManagerTaskRow(db, "mgr-1", { title: "Replace smoke detector", assignee: { type: "team", id: "mgr-2", name: "Dana" } });
    expect(emitVendorTaskAssigned).not.toHaveBeenCalled();

    const moved = await patchManagerTaskRow(db, "mgr-1", task.id, { assignee: vendor });
    expect(emitVendorTaskAssigned).toHaveBeenCalledTimes(1);
    expect(emitVendorTaskAssigned.mock.calls[0]![1]).toMatchObject({ managerUserId: "mgr-1", changedAt: moved.updatedAt });

    await patchManagerTaskRow(db, "mgr-1", task.id, { assignee: vendor, title: "Replace smoke detector (kitchen)" });
    await patchManagerTaskRow(db, "mgr-1", task.id, { completed: true });
    expect(emitVendorTaskAssigned).toHaveBeenCalledTimes(1);
  });

  it("reassigning to a different vendor messages the new one", async () => {
    const db = makeDb();
    const task = await createManagerTaskRow(db, "mgr-1", { title: "Replace smoke detector", assignee: vendor });
    await patchManagerTaskRow(db, "mgr-1", task.id, { assignee: { type: "vendor", id: "vd-2", name: "Other Co" } });
    expect(emitVendorTaskAssigned).toHaveBeenCalledTimes(2);
    expect(emitVendorTaskAssigned.mock.calls[1]![1].task.assignee.id).toBe("vd-2");
  });

  it("a message that cannot be sent never fails the save", async () => {
    emitVendorTaskAssigned.mockRejectedValue(new Error("delivery down"));
    const task = await createManagerTaskRow(makeDb(), "mgr-1", { title: "Replace smoke detector", assignee: vendor });
    expect(task.title).toBe("Replace smoke detector");
  });
});
