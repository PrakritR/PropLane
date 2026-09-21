import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/co-manager-notification.server", () => ({
  notifyPromotedToMainManager: vi.fn(),
  notifyDemotedToCoManager: vi.fn(),
}));

type Resp = { data?: unknown; error?: unknown; count?: number | null };

/**
 * A `db.from(table)` dispatcher in the spirit of
 * tests/unit/property-ownership-transfer.test.ts's `buildQueueDb`: each call
 * pops the next queued response for that table. Every returned chain is both
 * awaitable directly (for `.eq(...)` count queries, which resolve to
 * `{ data, error, count }` without a `.maybeSingle()`) and carries
 * `.maybeSingle()` (resolving to `{ data, error }`), since this module uses
 * both shapes against different tables.
 */
function buildQueueDb(responses: Record<string, Resp[]>) {
  const calls: Record<string, unknown[][]> = {};

  function buildChain(resp: Resp) {
    const self = Promise.resolve({
      data: resp.data ?? null,
      error: resp.error ?? null,
      count: resp.count ?? null,
    }) as unknown as Record<string, unknown>;
    self.select = vi.fn(() => self);
    self.eq = vi.fn((...args: unknown[]) => {
      return self;
    });
    self.order = vi.fn(() => self);
    self.limit = vi.fn(() => self);
    self.maybeSingle = vi.fn(() => Promise.resolve({ data: resp.data ?? null, error: resp.error ?? null }));
    return self;
  }

  const from = vi.fn((table: string) => {
    const queue = responses[table] ?? [];
    const resp = queue.length ? queue.shift()! : { data: null, error: null };
    (calls[table] ??= []).push([]);
    return buildChain(resp);
  });

  const rpc = vi.fn();

  return { db: { from, rpc } as never, from, rpc, calls };
}

const WORKSPACE_ROW = { id: "ws-1", name: "Acme Portfolio", owner_user_id: "owner-1" };
const PROFILE = (name: string) => ({ full_name: name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com` });

describe("transferWorkspaceOwnership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects when the caller is not the workspace owner", async () => {
    const { db } = buildQueueDb({
      portal_workspaces: [{ data: { ...WORKSPACE_ROW, owner_user_id: "someone-else" } }],
    });
    const { transferWorkspaceOwnership } = await import("@/lib/workspace-ownership-transfer");
    const result = await transferWorkspaceOwnership(db, {
      workspaceId: "ws-1",
      currentOwnerUserId: "owner-1",
      newOwnerUserId: "member-1",
      formerOwnerRole: "admin",
      formerOwnerPermissions: {},
    });
    expect(result).toEqual({ ok: false, error: "Only the workspace owner can transfer ownership.", status: 403 });
  });

  it("404s when the workspace does not exist", async () => {
    const { db } = buildQueueDb({ portal_workspaces: [{ data: null }] });
    const { transferWorkspaceOwnership } = await import("@/lib/workspace-ownership-transfer");
    const result = await transferWorkspaceOwnership(db, {
      workspaceId: "ws-missing",
      currentOwnerUserId: "owner-1",
      newOwnerUserId: "member-1",
      formerOwnerRole: "admin",
      formerOwnerPermissions: {},
    });
    expect(result).toEqual({ ok: false, error: "Workspace not found.", status: 404 });
  });

  it("404s when the target is not an accepted member of the workspace", async () => {
    const { db } = buildQueueDb({
      portal_workspaces: [{ data: WORKSPACE_ROW }],
      account_link_invites: [{ data: null }],
    });
    const { transferWorkspaceOwnership } = await import("@/lib/workspace-ownership-transfer");
    const result = await transferWorkspaceOwnership(db, {
      workspaceId: "ws-1",
      currentOwnerUserId: "owner-1",
      newOwnerUserId: "member-1",
      formerOwnerRole: "admin",
      formerOwnerPermissions: {},
    });
    expect(result).toEqual({ ok: false, error: "That person isn't a member of this workspace.", status: 404 });
  });

  it("400s when transferring to yourself", async () => {
    const { db } = buildQueueDb({});
    const { transferWorkspaceOwnership } = await import("@/lib/workspace-ownership-transfer");
    const result = await transferWorkspaceOwnership(db, {
      workspaceId: "ws-1",
      currentOwnerUserId: "owner-1",
      newOwnerUserId: "owner-1",
      formerOwnerRole: "admin",
      formerOwnerPermissions: {},
    });
    expect(result).toEqual({ ok: false, error: "Choose a different member to transfer to.", status: 400 });
  });

  it("409s when the new owner already owns 3 workspaces", async () => {
    const { db } = buildQueueDb({
      portal_workspaces: [{ data: WORKSPACE_ROW }, { data: null, count: 3 }],
      account_link_invites: [{ data: { id: "link-1" } }],
      profiles: [{ data: PROFILE("Former Owner") }, { data: PROFILE("Jordan Lee") }],
    });
    const { transferWorkspaceOwnership } = await import("@/lib/workspace-ownership-transfer");
    const result = await transferWorkspaceOwnership(db, {
      workspaceId: "ws-1",
      currentOwnerUserId: "owner-1",
      newOwnerUserId: "member-1",
      formerOwnerRole: "admin",
      formerOwnerPermissions: {},
    });
    expect(result).toEqual({ ok: false, error: "Jordan Lee already owns 3 workspaces, the limit.", status: 409 });
  });

  it("maps a missing-function rpc error to 503", async () => {
    const { db, rpc } = buildQueueDb({
      portal_workspaces: [{ data: WORKSPACE_ROW }, { data: null, count: 0 }],
      account_link_invites: [{ data: { id: "link-1" } }],
      profiles: [{ data: PROFILE("Former Owner") }, { data: PROFILE("Jordan Lee") }],
    });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'function "transfer_portal_workspace_ownership" does not exist' } });
    const { transferWorkspaceOwnership } = await import("@/lib/workspace-ownership-transfer");
    const result = await transferWorkspaceOwnership(db, {
      workspaceId: "ws-1",
      currentOwnerUserId: "owner-1",
      newOwnerUserId: "member-1",
      formerOwnerRole: "admin",
      formerOwnerPermissions: {},
    });
    expect(result).toEqual({ ok: false, error: "Transfer isn't available yet.", status: 503 });
  });

  it("calls the rpc with the exact args and returns houses/members on success", async () => {
    const { db, rpc } = buildQueueDb({
      portal_workspaces: [{ data: WORKSPACE_ROW }, { data: null, count: 1 }],
      account_link_invites: [{ data: { id: "link-1" } }],
      profiles: [{ data: PROFILE("Former Owner") }, { data: PROFILE("Jordan Lee") }],
      manager_property_records: [{ data: { id: "prop-a", property_data: { buildingName: "Bay House" } } }],
    });
    rpc.mockResolvedValueOnce({ data: { houses: 2, members: 3 }, error: null });
    const { transferWorkspaceOwnership } = await import("@/lib/workspace-ownership-transfer");
    const result = await transferWorkspaceOwnership(db, {
      workspaceId: "ws-1",
      currentOwnerUserId: "owner-1",
      newOwnerUserId: "member-1",
      formerOwnerRole: "custom",
      formerOwnerPermissions: { applications: true },
    });
    expect(rpc).toHaveBeenCalledWith("transfer_portal_workspace_ownership", {
      p_workspace: "ws-1",
      p_from: "owner-1",
      p_to: "member-1",
      p_former_role: "custom",
      p_former_permissions: { applications: true },
    });
    expect(result).toEqual({ ok: true, houses: 2, members: 3, workspaceName: "Acme Portfolio" });
  });
});

describe("workspace transfer migration table list", () => {
  it("rewrites exactly the tables transferPropertyOwnership rewrites, in the same order", () => {
    const libSource = readFileSync(resolve("src/lib/property-ownership-transfer.ts"), "utf8");
    const libMatch = libSource.match(/const propertyTables = \[([\s\S]*?)\] as const;/);
    if (!libMatch) throw new Error("Could not find propertyTables in property-ownership-transfer.ts");
    const libTables = Array.from(libMatch[1]!.matchAll(/"([a-z_]+)"/g)).map((m) => m[1]);
    expect(libTables.length).toBeGreaterThan(0);

    const migrationSource = readFileSync(
      resolve("supabase/migrations/20260921000000_workspace_ownership_transfer.sql"),
      "utf8",
    );
    const migrationMatch = migrationSource.match(/v_property_tables text\[\] := array\[([\s\S]*?)\];/);
    if (!migrationMatch) throw new Error("Could not find v_property_tables in the migration");
    const migrationTables = Array.from(migrationMatch[1]!.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);

    expect([...migrationTables].sort()).toEqual([...libTables].sort());
    expect(migrationTables).toEqual(libTables);
  });

  it("also rewrites assigned_property_id on the two tables transferPropertyOwnership does", () => {
    const migrationSource = readFileSync(
      resolve("supabase/migrations/20260921000000_workspace_ownership_transfer.sql"),
      "utf8",
    );
    const match = migrationSource.match(/v_assigned_property_id_tables text\[\] := array\[([\s\S]*?)\];/);
    if (!match) throw new Error("Could not find v_assigned_property_id_tables in the migration");
    const tables = Array.from(match[1]!.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
    expect(tables).toEqual(["manager_application_records", "portal_work_order_records"]);
  });
});
