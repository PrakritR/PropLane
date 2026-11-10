import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const loadServiceStaffWorkspaces = vi.fn();
const actorWorkspaceStanding = vi.fn();

vi.mock("@/lib/service/service-mode.server", () => ({
  loadServiceStaffWorkspaces: (...args: unknown[]) => loadServiceStaffWorkspaces(...args),
}));
vi.mock("@/lib/workspaces/membership.server", () => ({
  actorWorkspaceStanding: (...args: unknown[]) => actorWorkspaceStanding(...args),
}));

import { assertSettingsScopeOwned } from "@/lib/scope/settings-scope";

type Row = Record<string, unknown>;
function makeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(col: string, val: unknown) {
          filters.push((r) => String(r[col]) === String(val));
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return builder as never;
    },
  } as unknown as SupabaseClient;
}

const OWNER = "client-owner";
const STAFF = "staff-user";
const STRANGER = "stranger";
const WS_SERVICE = "ws-service";
const WS_PLAIN = "ws-plain";

function db() {
  return makeDb({
    portal_workspaces: [
      { id: WS_SERVICE, owner_user_id: OWNER, is_service: true },
      { id: WS_PLAIN, owner_user_id: OWNER, is_service: false },
    ],
    manager_property_records: [{ id: "house-1", manager_user_id: OWNER, workspace_id: WS_SERVICE }],
  });
}

beforeEach(() => {
  loadServiceStaffWorkspaces.mockReset();
  actorWorkspaceStanding.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("assertSettingsScopeOwned - PropLane Service staff", () => {
  it("the workspace owner is ok and never consults the staff decision", async () => {
    const result = await assertSettingsScopeOwned(db(), OWNER, { workspaceId: WS_SERVICE });
    expect(result).toEqual({ ok: true, ownerUserId: OWNER, workspaceId: WS_SERVICE, propertyId: null });
    expect(loadServiceStaffWorkspaces).not.toHaveBeenCalled();
  });

  it("service staff with an admin seat is ok and acts on the OWNER's rows, for read and edit", async () => {
    loadServiceStaffWorkspaces.mockResolvedValue([{ id: WS_SERVICE, name: "W", city: null, ownerUserId: OWNER }]);
    actorWorkspaceStanding.mockResolvedValue({
      workspaceId: WS_SERVICE,
      workspaceName: "W",
      ownerUserId: OWNER,
      role: "admin",
      rights: { members: true, houses: true },
      linkId: "l1",
    });
    for (const intent of ["read", "edit"] as const) {
      const result = await assertSettingsScopeOwned(db(), STAFF, { workspaceId: WS_SERVICE }, { intent });
      expect(result).toEqual({ ok: true, ownerUserId: OWNER, workspaceId: WS_SERVICE, propertyId: null });
    }
  });

  it("a Viewer seat reads but its writes (the default intent) are refused 403", async () => {
    loadServiceStaffWorkspaces.mockResolvedValue([{ id: WS_SERVICE, name: "W", city: null, ownerUserId: OWNER }]);
    actorWorkspaceStanding.mockResolvedValue({
      workspaceId: WS_SERVICE,
      workspaceName: "W",
      ownerUserId: OWNER,
      role: "viewer",
      rights: { members: false, houses: false },
      linkId: "l2",
    });
    const read = await assertSettingsScopeOwned(db(), STAFF, { workspaceId: WS_SERVICE }, { intent: "read" });
    expect(read).toEqual({ ok: true, ownerUserId: OWNER, workspaceId: WS_SERVICE, propertyId: null });
    const write = await assertSettingsScopeOwned(db(), STAFF, { workspaceId: WS_SERVICE });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.status).toBe(403);
    const explicitEdit = await assertSettingsScopeOwned(db(), STAFF, { workspaceId: WS_SERVICE }, { intent: "edit" });
    expect(explicitEdit.ok).toBe(false);
  });

  it("a non-service workspace the caller does not own is refused even for a staff member elsewhere", async () => {
    loadServiceStaffWorkspaces.mockResolvedValue([{ id: WS_SERVICE, name: "W", city: null, ownerUserId: OWNER }]);
    const result = await assertSettingsScopeOwned(db(), STAFF, { workspaceId: WS_PLAIN }, { intent: "read" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("an is_service workspace whose caller is not staff is refused", async () => {
    loadServiceStaffWorkspaces.mockResolvedValue([]);
    const result = await assertSettingsScopeOwned(db(), STRANGER, { workspaceId: WS_SERVICE }, { intent: "read" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("an unreadable staff decision fails closed", async () => {
    loadServiceStaffWorkspaces.mockRejectedValue(new Error("boom"));
    const result = await assertSettingsScopeOwned(db(), STAFF, { workspaceId: WS_SERVICE }, { intent: "read" });
    expect(result.ok).toBe(false);
  });

  it("a staff seat reaches a house of a service workspace through its workspace, never a foreign one", async () => {
    loadServiceStaffWorkspaces.mockResolvedValue([{ id: WS_SERVICE, name: "W", city: null, ownerUserId: OWNER }]);
    const ok = await assertSettingsScopeOwned(db(), STAFF, { propertyId: "house-1" }, { intent: "read" });
    expect(ok).toEqual({ ok: true, ownerUserId: OWNER, workspaceId: WS_SERVICE, propertyId: "house-1" });
    const foreign = makeDb({
      portal_workspaces: [{ id: "ws-other", owner_user_id: "someone", is_service: false }],
      manager_property_records: [{ id: "house-x", manager_user_id: "someone", workspace_id: "ws-other" }],
    });
    const refused = await assertSettingsScopeOwned(foreign, STAFF, { propertyId: "house-x" }, { intent: "read" });
    expect(refused.ok).toBe(false);
  });
});
