import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tasks are stored one JSON array per manager row (`portal_schedule_records`),
 * always `property_id: null` on the row itself — each task's own house lives
 * inside the array. There is no SQL column to add an `.in(...)` predicate to,
 * so `loadManagerTasksInActiveWorkspace` filters the already-decoded array in
 * process — the one allowed exception to "filter in SQL" (see
 * `src/lib/manager-tasks.server.ts`'s doc comment on that function).
 */

vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  viewerAndLinkedOwnerIdsForModule: vi.fn(async (_db: unknown, viewerUserId: string) => [viewerUserId]),
}));

const workspace = vi.hoisted(() => ({
  value: null as { owned: boolean; isDefault: boolean; propertyIds: string[] } | null,
  throws: false,
}));
vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspaceFromRequest: vi.fn(async () => {
    if (workspace.throws) throw new Error("workspace lookup failed");
    return workspace.value;
  }),
}));

import { loadManagerTasksInActiveWorkspace } from "@/lib/manager-tasks.server";
import { managerTasksStorageKey } from "@/lib/manager-tasks";

type Task = Record<string, unknown>;

function task(id: string, propertyId?: string): Task {
  return {
    id,
    title: `Task ${id}`,
    completed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(propertyId ? { propertyId } : {}),
  };
}

function mockDb(tasks: Task[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { row_data: { tasks } }, error: null }),
        }),
      }),
    }),
  };
}

const MANAGER = "mgr-1";

beforeEach(() => {
  vi.clearAllMocks();
  workspace.throws = false;
  workspace.value = { owned: true, isDefault: true, propertyIds: ["house-a"] };
});

describe("loadManagerTasksInActiveWorkspace", () => {
  it("shows only house-a tasks plus the untagged task while the default workspace (house-a) is active", async () => {
    const db = mockDb([task("t-a", "house-a"), task("t-b", "house-b"), task("t-none")]);
    const tasks = await loadManagerTasksInActiveWorkspace(db as never, MANAGER);
    expect(tasks.map((t) => t.id).sort()).toEqual(["t-a", "t-none"]);
  });

  it("shows only house-b tasks, no untagged one, once a non-default workspace (house-b) is active", async () => {
    workspace.value = { owned: true, isDefault: false, propertyIds: ["house-b"] };
    const db = mockDb([task("t-a", "house-a"), task("t-b", "house-b"), task("t-none")]);
    const tasks = await loadManagerTasksInActiveWorkspace(db as never, MANAGER);
    expect(tasks.map((t) => t.id)).toEqual(["t-b"]);
  });

  it("shows nothing for a workspace holding zero houses", async () => {
    workspace.value = { owned: true, isDefault: false, propertyIds: [] };
    const db = mockDb([task("t-a", "house-a"), task("t-b", "house-b")]);
    const tasks = await loadManagerTasksInActiveWorkspace(db as never, MANAGER);
    expect(tasks).toEqual([]);
  });

  it("switching the active workspace changes which tasks show", async () => {
    const db = mockDb([task("t-a", "house-a"), task("t-b", "house-b")]);
    expect((await loadManagerTasksInActiveWorkspace(db as never, MANAGER)).map((t) => t.id)).toEqual(["t-a"]);
    workspace.value = { owned: true, isDefault: false, propertyIds: ["house-b"] };
    expect((await loadManagerTasksInActiveWorkspace(db as never, MANAGER)).map((t) => t.id)).toEqual(["t-b"]);
  });

  it("is unaffected for a single-workspace manager (workspace holds every house)", async () => {
    workspace.value = { owned: true, isDefault: true, propertyIds: ["house-a", "house-b"] };
    const db = mockDb([task("t-a", "house-a"), task("t-b", "house-b"), task("t-none")]);
    const tasks = await loadManagerTasksInActiveWorkspace(db as never, MANAGER);
    expect(tasks.map((t) => t.id).sort()).toEqual(["t-a", "t-b", "t-none"]);
  });

  it("never narrows (returns the full list) when the workspace cannot be resolved", async () => {
    workspace.throws = true;
    const db = mockDb([task("t-a", "house-a"), task("t-b", "house-b")]);
    const tasks = await loadManagerTasksInActiveWorkspace(db as never, MANAGER);
    expect(tasks.map((t) => t.id).sort()).toEqual(["t-a", "t-b"]);
  });
});
