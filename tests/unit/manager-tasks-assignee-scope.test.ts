/**
 * AXI-159 — "both can choose an assignee. this creates a task for that specific
 * assignee and update in their personal calendar."
 *
 * Tasks are stored one row per manager, so a task the OWNER creates and assigns
 * to a co-manager lives in the OWNER's row. Reading only the caller's own row is
 * why the assigned task never reached the person it was assigned to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ownerIds = vi.hoisted(() => ({ value: ["cm-1", "owner-1"] as string[], throws: false }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  viewerAndLinkedOwnerIdsForModule: vi.fn(async () => {
    if (ownerIds.throws) throw new Error("scope read failed");
    return ownerIds.value;
  }),
}));

import { loadManagerTasks, patchManagerTaskRow } from "@/lib/manager-tasks.server";
import { managerTasksStorageKey } from "@/lib/manager-tasks";

type Task = Record<string, unknown>;

function task(id: string, assigneeId: string | null, type: "team" | "vendor" = "team"): Task {
  return {
    id,
    title: `Tour · ${id}`,
    completed: false,
    taskType: "tour",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(assigneeId ? { assignee: { type, id: assigneeId, name: "Someone" } } : {}),
  };
}

const saved: { id: string; tasks: Task[] }[] = [];

function mockDb(records: Record<string, Task[]>) {
  return {
    from: () => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => ({ data: { row_data: { tasks: records[id] ?? [] } }, error: null }),
        }),
      }),
      upsert: async (row: { id: string; row_data: { tasks: Task[] } }) => {
        saved.push({ id: row.id, tasks: row.row_data.tasks });
        return { error: null };
      },
    }),
  };
}

const OWNER_KEY = managerTasksStorageKey("owner-1");
const CM_KEY = managerTasksStorageKey("cm-1");

describe("manager task assignee scope", () => {
  beforeEach(() => {
    saved.length = 0;
    ownerIds.value = ["cm-1", "owner-1"];
    ownerIds.throws = false;
  });

  it("gives the assignee the task the owner assigned to them", async () => {
    const db = mockDb({
      [CM_KEY]: [task("own-1", "cm-1")],
      [OWNER_KEY]: [task("assigned-1", "cm-1"), task("owner-only", "owner-1")],
    });
    const tasks = await loadManagerTasks(db as never, "cm-1");
    expect(tasks.map((t) => t.id)).toEqual(["own-1", "assigned-1"]);
  });

  it("never leaks the owner's unassigned work", async () => {
    // Only assigned rows cross the boundary — a co-manager must not inherit the
    // owner's whole task list just by being linked.
    const db = mockDb({
      [CM_KEY]: [],
      [OWNER_KEY]: [task("owner-only", "owner-1"), task("unassigned", null)],
    });
    expect(await loadManagerTasks(db as never, "cm-1")).toEqual([]);
  });

  it("a vendor id is not a user id", async () => {
    const db = mockDb({ [CM_KEY]: [], [OWNER_KEY]: [task("v-1", "cm-1", "vendor")] });
    expect(await loadManagerTasks(db as never, "cm-1")).toEqual([]);
  });

  it("still returns the viewer's own tasks when the scope read fails", async () => {
    // Degrading to nothing would blank a manager's whole task list over an
    // unrelated permissions read.
    ownerIds.throws = true;
    const db = mockDb({ [CM_KEY]: [task("own-1", "cm-1")] });
    expect((await loadManagerTasks(db as never, "cm-1")).map((t) => t.id)).toEqual(["own-1"]);
  });

  it("the assignee can complete it, and it saves back to the OWNER's record", async () => {
    const db = mockDb({ [CM_KEY]: [], [OWNER_KEY]: [task("assigned-1", "cm-1")] });
    const next = await patchManagerTaskRow(db as never, "cm-1", "assigned-1", { completed: true });
    expect(next.completed).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe(OWNER_KEY);
  });

  it("the assignee cannot reassign it away or move it to another house", async () => {
    const db = mockDb({ [CM_KEY]: [], [OWNER_KEY]: [task("assigned-1", "cm-1")] });
    await expect(
      patchManagerTaskRow(db as never, "cm-1", "assigned-1", {
        assignee: { type: "team", id: "cm-2", name: "Other" },
      }),
    ).rejects.toThrow("Task not found.");
    expect(saved).toHaveLength(0);
  });

  it("cannot touch a linked owner's task that is not assigned to them", async () => {
    const db = mockDb({ [CM_KEY]: [], [OWNER_KEY]: [task("owner-only", "owner-1")] });
    await expect(
      patchManagerTaskRow(db as never, "cm-1", "owner-only", { completed: true }),
    ).rejects.toThrow("Task not found.");
    expect(saved).toHaveLength(0);
  });
});
