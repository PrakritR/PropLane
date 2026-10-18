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
const CLIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CLIENT2 = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const RESIDENT = "aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa";

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
    profile_roles: [OWNER, CLIENT, CLIENT2].map((user_id) => ({ user_id, role: "manager" })).concat([{ user_id: RESIDENT, role: "resident" }]),
    profiles: [OWNER, ADMIN_A, ADMIN_B, MANAGER, OUTSIDER, CLIENT, CLIENT2, RESIDENT].map((id) => ({
      id,
      full_name: `Name ${id.slice(0, 4)}`,
      email: `${id.slice(0, 4)}@example.com`,
      manager_id: `AX-${id.slice(0, 4).toUpperCase()}`,
    })),
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
    db = makeServiceFakeDb({ platform_service_settings: [], profile_roles: [{ user_id: OWNER, role: "manager" }], profiles: [{ id: OWNER }, { id: MANAGER }] });
    expect(await owner.resolveServiceOwner(client(), { PROPLANE_SERVICE_OWNER_USER_ID: MANAGER })).toEqual({ ok: false, reason: "not_configured" });
    expect(db.tables.platform_service_settings).toHaveLength(0);
    expect(await owner.resolveServiceOwner(client(), { PROPLANE_SERVICE_OWNER_USER_ID: "not-a-uuid" })).toEqual({ ok: false, reason: "not_configured" });
    expect(await owner.resolveServiceOwner(client(), { PROPLANE_SERVICE_OWNER_USER_ID: OWNER })).toEqual({ ok: true, ownerUserId: OWNER });
    expect(db.tables.platform_service_settings).toHaveLength(1);
  });

  it("needs the owner to be a property-portal manager too: sweepers delete links whose inviter is not one", async () => {
    db.tables.profile_roles = [];
    expect(await owner.resolveServiceOwner(client(), {})).toEqual({ ok: false, reason: "not_configured" });
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: null })).toMatchObject({ ok: false, status: 409 });
    expect(db.rpcCalls).toHaveLength(0);
    expect(await svc.listServiceWorkspaces(client(), ADMIN_A)).toMatchObject({ ok: true, payload: { configured: false } });
    // The same refusal at seed time.
    admins = new Set([OWNER]);
    const fresh = makeServiceFakeDb({ platform_service_settings: [], profile_roles: [], profiles: [{ id: OWNER }] });
    expect(await owner.resolveServiceOwner(fresh as never, { PROPLANE_SERVICE_OWNER_USER_ID: OWNER })).toEqual({ ok: false, reason: "not_configured" });
    expect(fresh.tables.platform_service_settings).toHaveLength(0);
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

describe("one workspace per owner client (per city, owner of record, invite)", () => {
  async function made(city: string | null = "Seattle", ownerOfRecord: unknown = "Maple Holdings") {
    return ((await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city, ownerOfRecord })) as { id: string }).id;
  }

  it("stores the client's name typed on +, shows it as the owner of record, and refuses an unusable one", async () => {
    const id = await made();
    expect(db.tables.portal_workspaces[0]).toMatchObject({ id, owner_of_record_name: "Maple Holdings", city: "Seattle" });
    const list = await svc.listServiceWorkspaces(client(), ADMIN_A);
    expect(list.ok && list.payload.workspaces[0]!.ownerOfRecord).toEqual({ name: "Maple Holdings", linked: false });
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: "X", city: null, ownerOfRecord: "n".repeat(81) })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id, name: "PropLane Seattle", city: "Seattle", ownerOfRecord: "Birch LLC" })).toEqual({ ok: true });
    expect(db.tables.portal_workspaces[0]!.owner_of_record_name).toBe("Birch LLC");
    // Omitting it on rename leaves it alone.
    await svc.renameServiceWorkspace(client(), ADMIN_A, { id, name: "PropLane Seattle 2", city: "Seattle" });
    expect(db.tables.portal_workspaces[0]!.owner_of_record_name).toBe("Birch LLC");
  });

  it("invites the property owner by PropLane ID as a PENDING Admin member flagged owner of record", async () => {
    const id = await made();
    const res = await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true });
    expect(res.ok).toBe(true);
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT)).toMatchObject({
      inviter_user_id: OWNER,
      workspace_id: id,
      team_role: "admin",
      house_scope: "all",
      status: "pending",
      is_owner_of_record: true,
    });
    // Nothing of the client's own accounts or workspaces is touched.
    expect(db.tables.portal_workspaces).toHaveLength(1);
    expect(db.tables.profile_roles).toHaveLength(4);
  });

  it("shows a pending invitee by the invite-time name snapshot only, with no email", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true });
    const team = await svc.listServiceTeam(client(), ADMIN_A, id);
    const row = team.ok ? team.members.find((m) => m.userId === CLIENT)! : null;
    expect(row).toMatchObject({ status: "pending", email: "", ownerOfRecord: true, role: "admin" });
    expect(team.ok && team.candidates.map((c) => c.userId)).not.toContain(CLIENT);
  });

  it("an accepted owner of record is the workspace's owner of record in the list, by name", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true });
    db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT)!.status = "accepted";
    const list = await svc.listServiceWorkspaces(client(), ADMIN_A);
    expect(list.ok && list.payload.workspaces[0]!.ownerOfRecord).toEqual({ name: "Name aaaa", linked: true });
    // The accepted client opens it in the normal portal like any Admin member.
    expect(await svc.authorizeOpenServiceWorkspace(client(), CLIENT, id)).toEqual({ ok: true, id });
  });

  it("allows only one owner of record per workspace, on invite and on flag", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA" })).toMatchObject({ ok: false, status: 409 });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true })).toMatchObject({ ok: false, status: 409 });
    // A second client person, flagged: refused while the first holds it; allowed after it is cleared.
    db.tables.profiles.find((p) => p.id === CLIENT2)!.manager_id = "AX-CLNT2";
    const link2 = (await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-CLNT2" })) as { linkId: string };
    expect(await svc.setServiceOwnerOfRecord(client(), ADMIN_A, { id, linkId: link2.linkId, value: true })).toMatchObject({ ok: false, status: 409 });
    const first = db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT)!;
    expect(await svc.setServiceOwnerOfRecord(client(), ADMIN_A, { id, linkId: String(first.id), value: false })).toEqual({ ok: true });
    expect(await svc.setServiceOwnerOfRecord(client(), ADMIN_A, { id, linkId: link2.linkId, value: true })).toEqual({ ok: true });
    expect(db.tables.account_link_invites.find((l) => l.id === link2.linkId)!.is_owner_of_record).toBe(true);
  });

  it("refuses an unknown ID, an account with no property portal, the owner, a duplicate, a non-member operator and a viewer", async () => {
    const id = await made();
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-NOPE" })).toMatchObject({ ok: false, status: 404 });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "" })).toMatchObject({ ok: false, status: 400 });
    db.tables.profiles.find((p) => p.id === RESIDENT)!.manager_id = "AX-RES";
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-RES" })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-1111" })).toMatchObject({ ok: false, status: 409 });
    expect(await svc.inviteServiceClient(client(), ADMIN_B, { id, proplaneId: "AX-AAAA" })).toMatchObject({ ok: false, status: 403 });
    db.tables.account_link_invites.push({ id: "viewer-link", inviter_user_id: OWNER, invitee_user_id: ADMIN_B, workspace_id: id, team_role: "viewer", status: "accepted" });
    expect(await svc.inviteServiceClient(client(), ADMIN_B, { id, proplaneId: "AX-AAAA" })).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.account_link_invites.filter((l) => l.status === "pending")).toHaveLength(0);
  });

  it("withdraws a pending invite", async () => {
    const id = await made();
    const sent = (await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA" })) as { linkId: string };
    expect(await svc.removeServiceTeamMember(client(), ADMIN_A, { id, linkId: sent.linkId })).toEqual({ ok: true });
    expect(db.tables.account_link_invites.find((l) => l.id === sent.linkId)!.status).toBe("cancelled");
  });
});
