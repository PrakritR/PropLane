import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

const loadServiceStaffWorkspaces = vi.fn();
const actorWorkspaceStanding = vi.fn();
vi.mock("@/lib/service/service-mode.server", () => ({
  loadServiceStaffWorkspaces: (...a: unknown[]) => loadServiceStaffWorkspaces(...a),
}));
vi.mock("@/lib/workspaces/membership.server", () => ({
  actorWorkspaceStanding: (...a: unknown[]) => actorWorkspaceStanding(...a),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerHasCoManagerPermissionForProperty: async () => false }));

import { assertSettingsScopeOwned, serviceStaffSettingsAccess } from "@/lib/scope/settings-scope";

const db = {
  from: () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: () => Promise.resolve({ data: { id: "ws", owner_user_id: "owner" }, error: null }),
    };
    return b;
  },
} as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("serviceStaffSettingsAccess unavailable", () => {
  it("returns unavailable when the staff read throws", async () => {
    loadServiceStaffWorkspaces.mockRejectedValue(new Error("db down"));
    expect(await serviceStaffSettingsAccess(db as never, "u", "ws", "read")).toEqual({ kind: "unavailable" });
  });

  it("assertSettingsScopeOwned maps it to 503, not 403", async () => {
    loadServiceStaffWorkspaces.mockRejectedValue(new Error("db down"));
    const r = await assertSettingsScopeOwned(db as never, "staff", { workspaceId: "ws" }, { intent: "read" });
    expect(r).toEqual({ ok: false, status: 503, error: "PropLane could not check your access. Try again." });
  });

  it("still answers 403 when staff access is readable and absent", async () => {
    loadServiceStaffWorkspaces.mockResolvedValue([]);
    const r = await assertSettingsScopeOwned(db as never, "stranger", { workspaceId: "ws" }, { intent: "read" });
    expect(r).toMatchObject({ ok: false, status: 403, error: "That workspace is not yours." });
  });

  it("the owner never needs the staff read", async () => {
    const r = await assertSettingsScopeOwned(db as never, "owner", { workspaceId: "ws" });
    expect(r).toMatchObject({ ok: true, ownerUserId: "owner" });
    expect(loadServiceStaffWorkspaces).not.toHaveBeenCalled();
  });
});
