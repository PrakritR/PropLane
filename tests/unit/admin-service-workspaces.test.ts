/**
 * PropLane Service workspaces (admin Service tab): ownership by the stored service owner, who may create /
 * open / manage, and that nothing a body names is ever authorization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN_A = "22222222-2222-4222-8222-222222222222";
const ADMIN_B = "33333333-3333-4333-8333-333333333333";
const MANAGER = "44444444-4444-4444-8444-444444444444";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";

let admins = new Set<string>();
vi.mock("@/lib/auth/admin-role", () => ({
  userHoldsAdminRole: async (_db: unknown, id: string) => admins.has(id),
  listAdminUserIds: async () => [...admins].sort(),
}));
vi.mock("@/lib/manager-access-server", () => ({
  ensureProfileProplaneId: async (_db: unknown, id: string) => ({
    ok: true,
    proplaneId: `AX-${id.slice(0, 4)}`,
    fullName: `Name ${id.slice(0, 4)}`,
    email: `${id.slice(0, 4)}@example.com`,
    role: "admin",
  }),
}));

const svc = await import("@/lib/service/service-workspaces.server");
const owner = await import("@/lib/service/service-owner.server");

let db: ServiceFakeDb;
const client = () => db as never;

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  admins = new Set([OWNER, ADMIN_A, ADMIN_B]);
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    profiles: [OWNER, ADMIN_A, ADMIN_B, MANAGER, OUTSIDER].map((id) => ({ id, full_name: `Name ${id.slice(0, 4)}`, email: `${id.slice(0, 4)}@example.com` })),
    portal_workspaces: [],
    account_link_invites: [],
    manager_property_records: [],
    manager_sms_numbers: [],
    sms_runtime_config: [],
    ...extra,
  });
}

beforeEach(() => seed());

describe("service owner resolution", () => {
  it("is not configured with no row and no env", async () => {
    db = makeServiceFakeDb({ platform_service_settings: [], profiles: [{ id: OWNER }] });
    expect(await owner.resolveServiceOwner(client(), {})).toEqual({ ok: false, reason: "not_configured" });
  });

  it("seeds the singleton from the env var only for an existing admin account", async () => {
    admins = new Set([OWNER]);
    db = makeServiceFakeDb({ platform_service_settings: [], profiles: [{ id: OWNER }, { id: MANAGER }] });
    expect(await owner.resolveServiceOwner(client(), { PROPLANE_SERVICE_OWNER_USER_ID: MANAGER })).toEqual({ ok: false, reason: "not_configured" });
    expect(db.tables.platform_service_settings).toHaveLength(0);
    expect(await owner.resolveServiceOwner(client(), { PROPLANE_SERVICE_OWNER_USER_ID: "not-a-uuid" })).toEqual({ ok: false, reason: "not_configured" });
    expect(await owner.resolveServiceOwner(client(), { PROPLANE_SERVICE_OWNER_USER_ID: OWNER })).toEqual({ ok: true, ownerUserId: OWNER });
    expect(db.tables.platform_service_settings).toHaveLength(1);
  });

  it("lets a stored row win over a different env value", async () => {
    expect(await owner.resolveServiceOwner(client(), { PROPLANE_SERVICE_OWNER_USER_ID: ADMIN_A })).toEqual({ ok: true, ownerUserId: OWNER });
  });

  it("treats a missing table (migration not run) as not configured and a real read failure as unreadable", async () => {
    db.failOn.platform_service_settings = { code: "42P01", message: "missing" };
    expect(await owner.resolveServiceOwner(client(), {})).toEqual({ ok: false, reason: "not_configured" });
    db.failOn.platform_service_settings = { code: "XX000", message: "boom" };
    expect(await owner.resolveServiceOwner(client(), {})).toEqual({ ok: false, reason: "unreadable" });
  });

  it("isPlatformServiceOwner is true only for the stored owner and fails closed", async () => {
    expect(await owner.isPlatformServiceOwner(client(), OWNER)).toBe(true);
    expect(await owner.isPlatformServiceOwner(client(), ADMIN_A)).toBe(false);
    expect(await owner.isPlatformServiceOwner(client(), "")).toBe(false);
    db.failOn.platform_service_settings = { code: "XX000", message: "boom" };
    expect(await owner.isPlatformServiceOwner(client(), OWNER)).toBe(false);
  });
});

describe("creating a service workspace (the + button)", () => {
  it("creates a workspace owned by the SERVICE OWNER, never the operator, and seats the operator as Admin", async () => {
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "  PropLane   Seattle ", city: "Seattle" });
    expect(res.ok).toBe(true);
    expect(db.rpcCalls).toEqual([{ fn: "create_portal_service_workspace", args: { p_owner: OWNER, p_name: "PropLane Seattle", p_city: "Seattle" } }]);
    const ws = db.tables.portal_workspaces[0]!;
    expect(ws).toMatchObject({ owner_user_id: OWNER, is_service: true, city: "Seattle", name: "PropLane Seattle", is_default: true });
    const link = db.tables.account_link_invites[0]!;
    expect(link).toMatchObject({
      inviter_user_id: OWNER,
      invitee_user_id: ADMIN_A,
      workspace_id: ws.id,
      team_role: "admin",
      house_scope: "all",
      status: "accepted",
      tab_kind: "manager",
    });
  });

  it("adds no membership row when the operator already is the owner, and a second workspace is not the default", async () => {
    await svc.createServiceWorkspace(client(), OWNER, { name: "PropLane Service", city: null });
    await svc.createServiceWorkspace(client(), OWNER, { name: "PropLane Portland", city: "Portland" });
    expect(db.tables.account_link_invites).toHaveLength(0);
    expect(db.tables.portal_workspaces.map((w) => w.is_default)).toEqual([true, false]);
  });

  it("refuses an unusable name or city before touching the database", async () => {
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: "   ", city: "x" })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: "x".repeat(81), city: "x" })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: "ok", city: "c".repeat(81) })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: 5, city: null })).toMatchObject({ ok: false, status: 400 });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("fails closed with 409 when no service owner is configured", async () => {
    db = makeServiceFakeDb({ platform_service_settings: [], profiles: [] });
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: null })).toMatchObject({ ok: false, status: 409 });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("undoes the workspace when its creator cannot be seated on it", async () => {
    db.failInsertOn.add("account_link_invites");
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: null });
    expect(res.ok).toBe(false);
    expect(db.tables.portal_workspaces).toHaveLength(0);
  });
});

describe("the Service list", () => {
  it("lists only service workspaces of the owner, with houses, number, team and the viewer's standing", async () => {
    const a = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: "Seattle" });
    expect(a.ok).toBe(true);
    const id = (a as { id: string }).id;
    // An ordinary manager workspace and the owner's non-service workspace never show.
    db.tables.portal_workspaces.push(
      { id: "66666666-6666-4666-8666-666666666666", owner_user_id: MANAGER, name: "Manager WS", is_default: true, is_service: false, created_at: "2026-01-01" },
      { id: "77777777-7777-4777-8777-777777777777", owner_user_id: OWNER, name: "Owner personal", is_default: false, is_service: false, created_at: "2026-01-01" },
    );
    db.tables.manager_property_records.push(
      { id: "h1", manager_user_id: OWNER, workspace_id: id },
      { id: "h2", manager_user_id: OWNER, workspace_id: id },
      { id: "h3", manager_user_id: MANAGER, workspace_id: "66666666-6666-4666-8666-666666666666" },
    );
    db.tables.manager_sms_numbers.push({ workspace_id: id, phone_number: "+12065550100", provision_state: "provisioned", released_at: null });
    const asA = await svc.listServiceWorkspaces(client(), ADMIN_A);
    const asB = await svc.listServiceWorkspaces(client(), ADMIN_B);
    expect(asA.ok && asA.payload.workspaces).toEqual([
      { id, name: "PropLane Seattle", city: "Seattle", isDefault: true, houseCount: 2, workNumber: "+12065550100", workNumberSource: "own", teamCount: 1, viewerRole: "admin", canManage: true },
    ]);
    expect(asB.ok && asB.payload.workspaces[0]).toMatchObject({ viewerRole: null, canManage: false });
  });

  it("shows the number the workspace actually texts from: the shared PropLane line by default, its own only if it holds one, and never provisions", async () => {
    const created = (await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: null })) as { id: string };
    const list = async () => {
      const r = await svc.listServiceWorkspaces(client(), ADMIN_A);
      return r.ok ? r.payload.workspaces[0]!.workNumber + "|" + r.payload.workspaces[0]!.workNumberSource : "fail";
    };
    // per_workspace (default / unreadable config): nothing to show.
    expect(await list()).toBe("null|null");
    // The shared line is on for this workspace: the default PropLane number.
    db.tables.sms_runtime_config = [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550111", shared_pilot_workspace_ids: [] }];
    expect(await list()).toBe("+12065550111|shared");
    // A paid specialized number of its own wins.
    db.tables.manager_sms_numbers.push({ workspace_id: created.id, phone_number: "+12065550199", provision_state: "provisioned", released_at: null });
    expect(await list()).toBe("+12065550199|own");
    // A released one is not the workspace's number.
    db.tables.manager_sms_numbers[0]!.released_at = "2026-10-01";
    expect(await list()).toBe("+12065550111|shared");
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["create_portal_service_workspace"]);
  });

  it("reports unconfigured instead of an error when there is no service owner", async () => {
    db = makeServiceFakeDb({ platform_service_settings: [], profiles: [] });
    expect(await svc.listServiceWorkspaces(client(), ADMIN_A)).toEqual({ ok: true, payload: { configured: false, ownerUserId: null, workspaces: [] } });
  });
});

describe("opening a service workspace", () => {
  async function made() {
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: null });
    return (res as { id: string }).id;
  }

  it("lets a member (and the owner) open it", async () => {
    const id = await made();
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_A, id)).toEqual({ ok: true, id });
    expect(await svc.authorizeOpenServiceWorkspace(client(), OWNER, id)).toEqual({ ok: true, id });
  });

  it("refuses an admin who is not on the team, with no cookie-worthy result", async () => {
    const id = await made();
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_B, id)).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a removed (cancelled) or pending membership", async () => {
    const id = await made();
    db.tables.account_link_invites[0]!.status = "cancelled";
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_A, id)).toMatchObject({ ok: false, status: 403 });
    db.tables.account_link_invites[0]!.status = "pending";
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_A, id)).toMatchObject({ ok: false, status: 403 });
  });

  it("treats any workspace that is not a service workspace of the owner as not found", async () => {
    const other = "66666666-6666-4666-8666-666666666666";
    db.tables.portal_workspaces.push(
      { id: other, owner_user_id: MANAGER, name: "Manager WS", is_default: true, is_service: false },
      { id: "88888888-8888-4888-8888-888888888888", owner_user_id: MANAGER, name: "Fake service", is_default: false, is_service: true },
      { id: "99999999-9999-4999-8999-999999999999", owner_user_id: OWNER, name: "Owner non-service", is_default: false, is_service: false },
    );
    for (const id of [other, "88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999", "nope", ""]) {
      expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_A, id)).toMatchObject({ ok: false, status: 404 });
    }
  });
});

describe("renaming and the team", () => {
  async function made() {
    return ((await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: null })) as { id: string }).id;
  }

  it("renames only for a workspace admin", async () => {
    const id = await made();
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id, name: "PropLane Seattle East", city: "Seattle" })).toEqual({ ok: true });
    expect(db.tables.portal_workspaces[0]).toMatchObject({ name: "PropLane Seattle East", city: "Seattle" });
    expect(await svc.renameServiceWorkspace(client(), ADMIN_B, { id, name: "Hijack", city: null })).toMatchObject({ ok: false, status: 403 });
    // A member without the members right (viewer) cannot rename either.
    db.tables.account_link_invites.push({ id: "viewer-link", inviter_user_id: OWNER, invitee_user_id: ADMIN_B, workspace_id: id, team_role: "viewer", status: "accepted" });
    expect(await svc.renameServiceWorkspace(client(), ADMIN_B, { id, name: "Hijack", city: null })).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.portal_workspaces[0]!.name).toBe("PropLane Seattle East");
  });

  it("adds a platform admin as an Admin member, once", async () => {
    const id = await made();
    const added = await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: ADMIN_B });
    expect(added.ok).toBe(true);
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === ADMIN_B)).toMatchObject({ team_role: "admin", workspace_id: id, inviter_user_id: OWNER, status: "accepted" });
    expect(await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: ADMIN_B })).toMatchObject({ ok: false, status: 409 });
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_B, id)).toEqual({ ok: true, id });
  });

  it("refuses a target who is not a platform admin, the owner, or a malformed id", async () => {
    const id = await made();
    expect(await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: MANAGER })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: OWNER })).toMatchObject({ ok: false, status: 409 });
    expect(await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: "x" })).toMatchObject({ ok: false, status: 400 });
    expect(db.tables.account_link_invites).toHaveLength(1);
  });

  it("refuses a non-member, and a member without the members right, from changing the team", async () => {
    const id = await made();
    expect(await svc.addServiceTeamMember(client(), ADMIN_B, { id, userId: ADMIN_B })).toMatchObject({ ok: false, status: 403 });
    db.tables.account_link_invites.push({ id: "viewer-link", inviter_user_id: OWNER, invitee_user_id: ADMIN_B, workspace_id: id, team_role: "viewer", status: "accepted" });
    expect(await svc.addServiceTeamMember(client(), ADMIN_B, { id, userId: ADMIN_B })).toMatchObject({ ok: false, status: 403 });
  });

  it("lists members and candidates (admins not yet on the team), candidates only for those who can manage", async () => {
    const id = await made();
    const asA = await svc.listServiceTeam(client(), ADMIN_A, id);
    expect(asA.ok && asA.members.map((m) => m.userId)).toEqual([ADMIN_A]);
    expect(asA.ok && asA.candidates.map((c) => c.userId)).toEqual([ADMIN_B]);
    db.tables.account_link_invites.push({ id: "viewer-link", inviter_user_id: OWNER, invitee_user_id: ADMIN_B, workspace_id: id, team_role: "viewer", status: "accepted" });
    const asB = await svc.listServiceTeam(client(), ADMIN_B, id);
    expect(asB.ok && asB.candidates).toEqual([]);
    expect(asB.ok && asB.canManage).toBe(false);
  });

  it("removes a member by cancelling that workspace's own row only", async () => {
    const id = await made();
    const added = (await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: ADMIN_B })) as { linkId: string };
    const other = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.tables.portal_workspaces.push({ id: other, owner_user_id: OWNER, name: "PropLane Portland", is_default: false, is_service: true });
    db.tables.account_link_invites.push({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", inviter_user_id: OWNER, invitee_user_id: ADMIN_B, workspace_id: other, team_role: "admin", status: "accepted" });
    // A link id from ANOTHER workspace, named through this one, is not found.
    expect(await svc.removeServiceTeamMember(client(), ADMIN_A, { id, linkId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })).toMatchObject({ ok: false, status: 404 });
    expect(await svc.removeServiceTeamMember(client(), ADMIN_A, { id, linkId: added.linkId })).toEqual({ ok: true });
    expect(db.tables.account_link_invites.find((l) => l.id === added.linkId)!.status).toBe("cancelled");
    expect(db.tables.account_link_invites.find((l) => l.id === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")!.status).toBe("accepted");
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_B, id)).toMatchObject({ ok: false, status: 403 });
  });
});
