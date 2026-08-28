import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/vendor-tasks.server", () => ({
  loadVendorAssignedTasks: vi.fn(),
  patchVendorAssignedTask: vi.fn(),
}));

import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadVendorAssignedTasks, patchVendorAssignedTask } from "@/lib/vendor-tasks.server";
import { GET, PATCH } from "@/app/api/vendor/tasks/route";

const TASK = {
  id: "task-1",
  title: "Replace filter",
  completed: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  managerUserId: "mgr-1",
  managerName: "Alex Manager",
  vendorDirectoryId: "vendor-dir-1",
};

describe("/api/vendor/tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({} as never);
    vi.mocked(resolveVendorPortalUserId).mockResolvedValue({ ok: true, userId: "vendor-user-1" });
    vi.mocked(loadVendorAssignedTasks).mockResolvedValue([TASK]);
    vi.mocked(patchVendorAssignedTask).mockResolvedValue({ ...TASK, completed: true });
  });

  it("GET returns assigned tasks for the authenticated vendor", async () => {
    const { status, data } = await parseJsonResponse<{ tasks?: { id: string }[] }>(await GET());
    expect(status).toBe(200);
    expect(loadVendorAssignedTasks).toHaveBeenCalledWith({}, "vendor-user-1");
    expect(data.tasks?.map((row) => row.id)).toEqual(["task-1"]);
  });

  it("GET returns 401 when unauthenticated", async () => {
    vi.mocked(resolveVendorPortalUserId).mockResolvedValue({ ok: false, status: 401 });
    const { status } = await parseJsonResponse(await GET());
    expect(status).toBe(401);
  });

  it("PATCH completes a task for the authenticated vendor", async () => {
    const { status, data } = await parseJsonResponse<{ task?: { completed?: boolean } }>(
      await PATCH(
        jsonRequest("http://localhost/api/vendor/tasks", {
          method: "PATCH",
          body: { managerUserId: "mgr-1", taskId: "task-1", completed: true },
        }),
      ),
    );
    expect(status).toBe(200);
    expect(patchVendorAssignedTask).toHaveBeenCalledWith({}, "vendor-user-1", {
      managerUserId: "mgr-1",
      taskId: "task-1",
      completed: true,
    });
    expect(data.task?.completed).toBe(true);
  });

  it("PATCH returns 400 when vendor lacks access", async () => {
    vi.mocked(patchVendorAssignedTask).mockRejectedValue(new Error("You do not have access to this task."));
    const { status, data } = await parseJsonResponse<{ error?: string }>(
      await PATCH(
        jsonRequest("http://localhost/api/vendor/tasks", {
          method: "PATCH",
          body: { managerUserId: "mgr-1", taskId: "task-2", completed: true },
        }),
      ),
    );
    expect(status).toBe(400);
    expect(data.error).toMatch(/access/i);
  });
});
