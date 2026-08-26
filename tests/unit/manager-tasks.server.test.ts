import { describe, expect, it, vi } from "vitest";
import { saveManagerTasks } from "@/lib/manager-tasks.server";
import { managerTasksStorageKey } from "@/lib/manager-tasks";

describe("manager-tasks.server", () => {
  it("persists tasks only on the manager-scoped record, not the shared planned-events singleton", async () => {
    const managerUserId = "mgr-user-1";
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          })),
        })),
        upsert,
      })),
    };

    await saveManagerTasks(db as never, managerUserId, [
      {
        id: "task-1",
        title: "Inspect unit",
        completed: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    expect(upsert).toHaveBeenCalledTimes(1);
    const payload = upsert.mock.calls[0]![0];
    expect(payload.id).toBe(managerTasksStorageKey(managerUserId));
    expect(payload.manager_user_id).toBe(managerUserId);
    expect(payload.id).not.toBe("axis_admin_planned_events_v1");
  });
});
