import { describe, expect, it } from "vitest";
import { managerTasksStorageKey } from "@/lib/manager-tasks";
import { loadVendorAssignedTasks, patchVendorAssignedTask } from "@/lib/vendor-tasks.server";

function mockDb(input: {
  vendorLinks?: { id: string; manager_user_id: string; row_data: Record<string, unknown> }[];
  tasksByManager?: Record<string, { row_data: { tasks: unknown[] } }>;
  profiles?: Record<string, string>;
}) {
  return {
    from(table: string) {
      const state: Record<string, unknown> = {};
      if (table === "manager_vendor_records") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: async () => ({
                  data: input.vendorLinks ?? [],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      const api = {
        select: () => api,
        eq: (col: string, val: string) => {
          state[col] = val;
          return api;
        },
        maybeSingle: async () => {
          if (table === "portal_schedule_records") {
            const id = state.id as string;
            for (const [managerUserId, record] of Object.entries(input.tasksByManager ?? {})) {
              if (id === managerTasksStorageKey(managerUserId)) {
                return { data: record, error: null };
              }
            }
            return { data: null, error: null };
          }
          if (table === "profiles") {
            const id = state.id as string;
            const name = input.profiles?.[id];
            return { data: name ? { full_name: name } : null, error: null };
          }
          return { data: null, error: null };
        },
        upsert: async () => ({ error: null }),
      };
      return api;
    },
  } as never;
}

describe("vendor-tasks.server", () => {
  it("returns only tasks assigned to the vendor directory row", async () => {
    const db = mockDb({
      vendorLinks: [{ id: "vendor-dir-1", manager_user_id: "mgr-1", row_data: {} }],
      profiles: { "mgr-1": "Alex Manager" },
      tasksByManager: {
        "mgr-1": {
          row_data: {
            tasks: [
              {
                id: "task-1",
                title: "Paint hallway",
                completed: false,
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
                assignee: { type: "vendor", id: "vendor-dir-1", name: "Pat Vendor" },
              },
              {
                id: "task-2",
                title: "Other task",
                completed: false,
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
                assignee: { type: "team", id: "co-1", name: "Co" },
              },
            ],
          },
        },
      },
    });

    const tasks = await loadVendorAssignedTasks(db, "vendor-user-1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("Paint hallway");
    expect(tasks[0]?.managerName).toBe("Alex Manager");
  });

  it("refuses patching tasks not assigned to the vendor", async () => {
    const db = mockDb({
      vendorLinks: [{ id: "vendor-dir-1", manager_user_id: "mgr-1", row_data: {} }],
      tasksByManager: {
        "mgr-1": {
          row_data: {
            tasks: [
              {
                id: "task-2",
                title: "Other task",
                completed: false,
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
                assignee: { type: "team", id: "co-1", name: "Co" },
              },
            ],
          },
        },
      },
    });

    await expect(
      patchVendorAssignedTask(db, "vendor-user-1", {
        managerUserId: "mgr-1",
        taskId: "task-2",
        completed: true,
      }),
    ).rejects.toThrow(/access/i);
  });
});
