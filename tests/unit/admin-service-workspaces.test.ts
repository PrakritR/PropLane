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
let failStrictAdminRead = false;
vi.mock("@/lib/auth/admin-role", () => ({
  userHoldsAdminRole: async (_db: unknown, id: string) => admins.has(id),
  userHoldsAdminRoleStrict: async (_db: unknown, id: string) => {
    if (failStrictAdminRead) throw new Error("role read failed");
    return admins.has(id);
  },
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

// Who pays for a personalized number: owner id -> true. Nobody by default (same fake the W16 config tests use).
const paid = vi.hoisted(() => ({ owners: new Set<string>() }));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async (_db: unknown, owner: string) =>
    paid.owners.has(owner)
      ? { ok: true as const, entitled: true as const, via: "plan" as const, tier: "pro" as const }
      : { ok: true as const, entitled: false as const, tier: "free" as const },
  ),
}));

// Email delivery for someone with no account yet goes through the Resend boundary; capture it, send nothing.
const sentEmails = vi.hoisted(() => ({ items: [] as Array<{ to: string[]; subject: string; text: string }> }));
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: vi.fn(async (args: { payload: { to: string[]; subject: string; text: string } }) => {
    sentEmails.items.push(args.payload);
    return new Response(JSON.stringify({ id: "captured" }), { status: 200 });
  }),
}));
process.env.RESEND_API_KEY = "re_test_key";

const svc = await import("@/lib/service/service-workspaces.server");
const owner = await import("@/lib/service/service-owner.server");
const mailbox = await import("@/lib/manager-assistant-email/manager-assistant-email.server");

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
    workspace_work_numbers: [],
    sms_runtime_config: [],
    ...extra,
  });
}

beforeEach(() => {
  failStrictAdminRead = false;
  paid.owners.clear();
  sentEmails.items.length = 0;
  seed();
});

/** The database trigger keeps an "all houses" seat's houses current; the fake has no triggers, so say it by hand. */
function seatHouses(workspaceId: string) {
  const houses = db.tables.manager_property_records.filter((h) => h.workspace_id === workspaceId).map((h) => h.id);
  for (const l of db.tables.account_link_invites) if (l.workspace_id === workspaceId && l.house_scope === "all") l.assigned_property_ids = houses;
}

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
      { id, name: "PropLane Seattle", city: "Seattle", ownerOfRecord: null, isDefault: true, houseCount: 2, workNumber: null, workNumberSource: null, oldNumber: null, teamCount: 1, viewerRole: "admin", canManage: true, feePercent: null },
    ]);
    expect(asB.ok && asB.payload.workspaces[0]).toMatchObject({ viewerRole: null, canManage: false });
  });

  it("shows the PropLane line (206) for a managed workspace, never a number it once held, and never provisions", async () => {
    const created = (await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: null })) as { id: string };
    const list = async () => {
      const r = await svc.listServiceWorkspaces(client(), ADMIN_A);
      return r.ok ? r.payload.workspaces[0]!.workNumber + "|" + r.payload.workspaces[0]!.workNumberSource : "fail";
    };
    // per_workspace with no service-owner number: the line cannot be resolved, so no number (and never the old one).
    expect(await list()).toBe("null|null");
    // The shared line is on: the managed workspace shows it.
    db.tables.sms_runtime_config = [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550111", shared_pilot_workspace_ids: [] }];
    expect(await list()).toBe("+12065550111|shared");
    // It still holds an old row of its own (and even pays for a personal number): the 206 is what is shown.
    db.tables.manager_sms_numbers.push({
      id: "n1",
      manager_user_id: OWNER,
      workspace_id: created.id,
      phone_number: "+12065550199",
      provision_state: "active",
      registration_state: "approved",
      released_at: null,
      requested_at: "2026-10-01T00:00:00.000Z",
    });
    paid.owners.add(OWNER);
    expect(await list()).toBe("+12065550111|shared");
    // A released one is history.
    db.tables.manager_sms_numbers[0]!.released_at = "2026-10-02";
    expect(await list()).toBe("+12065550111|shared");
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["create_portal_service_workspace"]);
  });

  it("per_workspace mode: the service owner's own default-workspace number is the line and is not an 'old number'", async () => {
    const created = (await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: null })) as { id: string };
    db.tables.manager_sms_numbers.push({ id: "n1", manager_user_id: OWNER, workspace_id: created.id, phone_number: "+12065550100", provision_state: "active", released_at: null });
    const r = await svc.listServiceWorkspaces(client(), ADMIN_A);
    expect(r.ok && r.payload.workspaces[0]).toMatchObject({ workNumber: "+12065550100", workNumberSource: "shared", oldNumber: null });
  });

  it("an attached workspace keeps its old number receive-only: the row shows the 206 plus 'old number kept since <attach date>'", async () => {
    const created = (await svc.createServiceWorkspace(client(), ADMIN_A, { name: "Ambika", city: "Seattle" })) as { id: string };
    db.tables.sms_runtime_config = [{ singleton: true, line_mode: "shared", shared_number_e164: "+12066781909", shared_pilot_workspace_ids: [] }];
    db.tables.manager_sms_numbers.push({ id: "n1", manager_user_id: OWNER, workspace_id: created.id, phone_number: "+18146793694", provision_state: "active", released_at: null, requested_at: "2026-08-01T00:00:00.000Z" });
    db.tables.audit_log = [
      { action: svc.ADMIN_SERVICE_ATTACH_AUDIT_ACTION, created_at: "2026-10-25T18:00:00.000Z", input_summary: { workspaceId: created.id } },
      { action: svc.ADMIN_SERVICE_ATTACH_AUDIT_ACTION, created_at: "2026-10-26T18:00:00.000Z", input_summary: { workspaceId: "someone-else" } },
    ];
    const r = await svc.listServiceWorkspaces(client(), ADMIN_A);
    expect(r.ok && r.payload.workspaces[0]).toMatchObject({
      workNumber: "+12066781909",
      workNumberSource: "shared",
      oldNumber: { phoneNumber: "+18146793694", since: "2026-10-25T18:00:00.000Z" },
    });
    // The workspace's own number is still routed inbound: the row is live and untouched by a list.
    expect(db.tables.manager_sms_numbers[0]!.released_at).toBeNull();
  });

  it("reports unconfigured instead of an error when there is no service owner", async () => {
    db = makeServiceFakeDb({ platform_service_settings: [], profiles: [] });
    expect(await svc.listServiceWorkspaces(client(), ADMIN_A)).toEqual({ ok: true, payload: { configured: false, ownerUserId: null, workspaces: [] } });
  });
});

describe("Release old number", () => {
  async function attachedWithOldNumber() {
    const created = (await svc.createServiceWorkspace(client(), ADMIN_A, { name: "Ambika", city: "Seattle" })) as { id: string };
    db.tables.sms_runtime_config = [{ singleton: true, line_mode: "shared", shared_number_e164: "+12066781909", shared_pilot_workspace_ids: [] }];
    db.tables.manager_sms_numbers.push({ id: "n1", manager_user_id: CLIENT, workspace_id: created.id, phone_number: "+18146793694", provision_state: "active", released_at: null });
    return created.id;
  }

  it("is admin only: a non-admin is refused before anything is read or written", async () => {
    const id = await attachedWithOldNumber();
    expect(await svc.releaseServiceWorkspaceOldNumber(client(), OUTSIDER, { id })).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.manager_sms_numbers[0]!.released_at).toBeNull();
    expect((db.tables.audit_log ?? []).filter((r) => r.action === svc.ADMIN_SERVICE_RELEASE_OLD_NUMBER_AUDIT_ACTION)).toHaveLength(0);
  });

  it("writes the audit row first: no audit row means the number is not released", async () => {
    const id = await attachedWithOldNumber();
    db.failInsertOn.add("audit_log");
    expect(await svc.releaseServiceWorkspaceOldNumber(client(), ADMIN_A, { id })).toMatchObject({ ok: false, status: 503 });
    expect(db.tables.manager_sms_numbers[0]!.released_at).toBeNull();
    db.failInsertOn.delete("audit_log");
    const done = await svc.releaseServiceWorkspaceOldNumber(client(), ADMIN_A, { id });
    expect(done).toMatchObject({ ok: true, released: "+18146793694" });
    const audit = (db.tables.audit_log ?? []).filter((r) => r.action === svc.ADMIN_SERVICE_RELEASE_OLD_NUMBER_AUDIT_ACTION);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: ADMIN_A, input_summary: { workspaceId: id, phoneNumbers: ["+18146793694"] } });
    expect(db.tables.manager_sms_numbers[0]!.released_at).toBeTruthy();
    expect(db.tables.manager_sms_numbers[0]!.provision_state).toBe("released");
  });

  it("refuses a workspace that holds the PropLane line itself, a non-service workspace, and a workspace with no old number", async () => {
    const id = await attachedWithOldNumber();
    db.tables.manager_sms_numbers.push({ id: "n2", manager_user_id: CLIENT, workspace_id: id, phone_number: "+12066781909", provision_state: "active", released_at: null });
    expect(await svc.releaseServiceWorkspaceOldNumber(client(), ADMIN_A, { id })).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.manager_sms_numbers.every((r) => r.released_at === null)).toBe(true);
    expect(await svc.releaseServiceWorkspaceOldNumber(client(), ADMIN_A, { id: "66666666-6666-4666-8666-666666666666" })).toMatchObject({ ok: false, status: 404 });
    db.tables.manager_sms_numbers = [];
    expect(await svc.releaseServiceWorkspaceOldNumber(client(), ADMIN_A, { id })).toMatchObject({ ok: false, status: 409 });
  });

  it("fails closed when the PropLane line cannot be resolved", async () => {
    const id = await attachedWithOldNumber();
    db.tables.sms_runtime_config = [];
    expect(await svc.releaseServiceWorkspaceOldNumber(client(), ADMIN_A, { id })).toMatchObject({ ok: false, status: 503 });
    expect(db.tables.manager_sms_numbers[0]!.released_at).toBeNull();
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

  it("treats any workspace without the service flag as not found; the flag alone is never authorization", async () => {
    const other = "66666666-6666-4666-8666-666666666666";
    db.tables.portal_workspaces.push(
      { id: other, owner_user_id: MANAGER, name: "Manager WS", is_default: true, is_service: false },
      { id: "88888888-8888-4888-8888-888888888888", owner_user_id: MANAGER, name: "Fake service", is_default: false, is_service: true },
      { id: "99999999-9999-4999-8999-999999999999", owner_user_id: OWNER, name: "Owner non-service", is_default: false, is_service: false },
    );
    for (const id of [other, "99999999-9999-4999-8999-999999999999", "nope", ""]) {
      expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_A, id)).toMatchObject({ ok: false, status: 404 });
    }
    // Flagged but owned by a client: it IS a service workspace, yet an operator who is not on its team still cannot open it.
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_A, "88888888-8888-4888-8888-888888888888")).toMatchObject({ ok: false, status: 403 });
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

  it("invites the property owner by PropLane ID as a PENDING Property owner (owner portal) flagged owner of record", async () => {
    const id = await made();
    db.tables.manager_property_records.push(
      { id: "house-a", manager_user_id: OWNER, workspace_id: id },
      { id: "house-b", manager_user_id: OWNER, workspace_id: id },
      { id: "house-x", manager_user_id: OWNER, workspace_id: "other-ws" },
    );
    const res = await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true });
    expect(res.ok).toBe(true);
    const row = db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT)!;
    expect(row).toMatchObject({
      inviter_user_id: OWNER,
      workspace_id: id,
      team_role: "property_owner",
      house_scope: "selected",
      assigned_property_ids: ["house-a", "house-b"],
      status: "pending",
      is_owner_of_record: true,
    });
    // Owner keys only (never a module grant), per house.
    expect(Object.keys(row.property_co_manager_permissions as object).sort()).toEqual(["house-a", "house-b"]);
    expect(row.property_co_manager_permissions).toMatchObject({ "house-a": { ownerPerformance: { read: true }, ownerStatements: { read: true }, ownerDocuments: { read: true } } });
    expect(JSON.stringify(row.co_manager_permissions)).not.toMatch(/"(properties|payments|financials|residents)"/);
    // Nothing of the client's own accounts or workspaces is touched.
    expect(db.tables.portal_workspaces).toHaveLength(1);
    expect(db.tables.profile_roles).toHaveLength(4);
  });

  it("invites someone on the client's side (not the owner of record) as an Admin member", async () => {
    const id = await made();
    expect((await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA" })).ok).toBe(true);
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT)).toMatchObject({ team_role: "admin", house_scope: "all", is_owner_of_record: false });
  });

  it("invites a helper by email: an Admin seat pinned to this workspace, pending until they accept", async () => {
    const id = await made();
    // No account with this email: a one-use invite link is emailed (the invite page creates the account).
    const res = await svc.inviteServiceClient(client(), ADMIN_A, { id, email: " Name.AAAA@Example.com " });
    expect(res).toMatchObject({ ok: true, delivery: "link" });
    expect(db.tables.account_link_invites.filter((l) => l.status === "pending")).toHaveLength(0);
    expect(sentEmails.items).toHaveLength(1);
    expect(sentEmails.items[0]!.to).toEqual(["name.aaaa@example.com"]);
    // An unknown PropLane ID has no email to send to: that is still a 404.
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-NOPE" })).toMatchObject({ ok: false, status: 404 });
    db.tables.profiles.find((p) => p.id === CLIENT)!.email = "helper@example.com";
    expect((await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "Helper@Example.com" })).ok).toBe(true);
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT)).toMatchObject({
      inviter_user_id: OWNER,
      workspace_id: id,
      team_role: "admin",
      status: "pending",
      is_owner_of_record: false,
    });
    // No platform admin role is granted by a seat.
    expect(admins.has(CLIENT)).toBe(false);
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "not-an-email" })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "helper@example.com" })).toMatchObject({ ok: false, status: 409 });
  });

  it("fails closed if the target admin role cannot be read", async () => {
    const id = await made();
    failStrictAdminRead = true;
    const before = db.tables.account_link_invites.length;
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true })).toMatchObject({ ok: false, status: 503 });
    expect(db.tables.account_link_invites).toHaveLength(before);
  });

  it("never makes a PropLane admin the owner of record, on invite or on flag", async () => {
    const id = await made();
    db.tables.profiles.find((p) => p.id === ADMIN_B)!.manager_id = "AX-BBBB";
    db.tables.profile_roles.push({ user_id: ADMIN_B, role: "manager" });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-BBBB", ownerOfRecord: true })).toMatchObject({ ok: false, status: 409 });
    const added = (await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: ADMIN_B })) as { linkId: string };
    expect(await svc.setServiceOwnerOfRecord(client(), ADMIN_A, { id, linkId: added.linkId, value: true })).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.account_link_invites.find((l) => l.id === added.linkId)).toMatchObject({ team_role: "admin", is_owner_of_record: false });
  });

  it("flagging an existing client member converts them to a Property owner of the workspace's houses", async () => {
    const id = await made();
    db.tables.manager_property_records.push({ id: "house-a", manager_user_id: OWNER, workspace_id: id });
    seatHouses(id);
    const sent = (await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA" })) as { linkId: string };
    expect(await svc.setServiceOwnerOfRecord(client(), ADMIN_A, { id, linkId: sent.linkId, value: true })).toEqual({ ok: true });
    expect(db.tables.account_link_invites.find((l) => l.id === sent.linkId)).toMatchObject({
      team_role: "property_owner",
      house_scope: "selected",
      assigned_property_ids: ["house-a"],
      is_owner_of_record: true,
    });
    // Clearing the flag leaves the owner role in place.
    expect(await svc.setServiceOwnerOfRecord(client(), ADMIN_A, { id, linkId: sent.linkId, value: false })).toEqual({ ok: true });
    expect(db.tables.account_link_invites.find((l) => l.id === sent.linkId)).toMatchObject({ team_role: "property_owner", is_owner_of_record: false });
  });

  it("shows a pending invitee by the invite-time name snapshot only, with no email", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true });
    const team = await svc.listServiceTeam(client(), ADMIN_A, id);
    const row = team.ok ? team.members.find((m) => m.userId === CLIENT)! : null;
    expect(row).toMatchObject({ status: "pending", email: "", ownerOfRecord: true, role: "property_owner" });
    expect(team.ok && team.candidates.map((c) => c.userId)).not.toContain(CLIENT);
  });

  it("an accepted owner of record is the workspace's owner of record in the list, by name", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true });
    db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT)!.status = "accepted";
    const list = await svc.listServiceWorkspaces(client(), ADMIN_A);
    expect(list.ok && list.payload.workspaces[0]!.ownerOfRecord).toEqual({ name: "Name aaaa", linked: true });
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

describe("attaching an existing workspace to PropLane Service (a flag plus memberships, not ownership)", () => {
  const CLIENT_WS = "cccccccc-1111-4111-8111-cccccccccccc";

  function seedClientWorkspace() {
    db.tables.portal_workspaces.push({ id: CLIENT_WS, owner_user_id: CLIENT, name: "Ambika Homes", is_default: true, is_service: false, city: null });
    db.tables.manager_property_records.push(
      { id: "house-1", manager_user_id: CLIENT, workspace_id: CLIENT_WS, row_data: { rent: 1 } },
      { id: "house-2", manager_user_id: CLIENT, workspace_id: CLIENT_WS, row_data: { rent: 2 } },
    );
    db.tables.audit_log = [];
  }
  const snapshotRows = () => JSON.stringify([db.tables.manager_property_records]);

  it("flags the workspace, seats the service owner and the operator as accepted Admins, flags the owner as owner of record, and changes nothing else", async () => {
    seedClientWorkspace();
    const before = snapshotRows();
    const res = await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: "Seattle", label: "Ambika - Seattle", reason: "Client asked for service" });
    expect(res).toEqual({ ok: true, id: CLIENT_WS });

    const ws = db.tables.portal_workspaces.find((w) => w.id === CLIENT_WS)!;
    // Owner and default flag are exactly as they were; the label is the workspace's name now.
    expect(ws).toMatchObject({ owner_user_id: CLIENT, name: "Ambika - Seattle", is_default: true, is_service: true, city: "Seattle" });
    // No property (or lease / charge) row was written, and no workspace was created or moved.
    expect(snapshotRows()).toBe(before);
    expect(db.rpcCalls).toEqual([]);
    expect(db.tables.portal_workspaces).toHaveLength(1);

    const links = db.tables.account_link_invites.filter((l) => l.workspace_id === CLIENT_WS);
    expect(links.map((l) => l.invitee_user_id).sort()).toEqual([OWNER, ADMIN_A].sort());
    for (const l of links) {
      expect(l).toMatchObject({ inviter_user_id: CLIENT, team_role: "admin", house_scope: "all", status: "accepted", is_owner_of_record: false });
    }
    // Audited, with the operator as the actor and the workspace owner as the subject, and stamped applied.
    expect(db.tables.audit_log).toHaveLength(1);
    expect(db.tables.audit_log[0]).toMatchObject({ actor_user_id: ADMIN_A, landlord_id: CLIENT, action: "admin_service_attach" });
    expect(db.tables.audit_log[0]!.result_summary).toEqual({ applied: true });
  });

  it("the attached workspace is listed with the other service workspaces, labelled, with its owner as owner of record", async () => {
    seedClientWorkspace();
    await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: "Seattle" });
    await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: "Seattle", label: "Ambika - Seattle", reason: "Client asked for service" });
    const list = await svc.listServiceWorkspaces(client(), ADMIN_A);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.payload.workspaces.map((w) => w.name).sort()).toEqual(["Ambika - Seattle", "PropLane Seattle"]);
    const attached = list.payload.workspaces.find((w) => w.name === "Ambika - Seattle")!;
    expect(attached).toMatchObject({ city: "Seattle", houseCount: 2, ownerOfRecord: { name: "Name aaaa", linked: true }, viewerRole: "admin", canManage: true, teamCount: 2 });
    // An admin who is not on its team sees it but cannot open it.
    const asB = await svc.listServiceWorkspaces(client(), ADMIN_B);
    expect(asB.ok && asB.payload.workspaces.find((w) => w.id === CLIENT_WS)).toMatchObject({ viewerRole: null, canManage: false });
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_B, CLIENT_WS)).toMatchObject({ ok: false, status: 403 });
    // The operator who attached it is a member, so Open (the workspace cookie) works for them.
    expect(await svc.authorizeOpenServiceWorkspace(client(), ADMIN_A, CLIENT_WS)).toEqual({ ok: true, id: CLIENT_WS });
  });

  it("rename changes the workspace's name and city and never its owner", async () => {
    seedClientWorkspace();
    await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: "Seattle", label: "Ambika - Seattle", reason: "Client asked for service" });
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: CLIENT_WS, name: "Ambika Portland", city: "Portland" })).toEqual({ ok: true });
    expect(db.tables.portal_workspaces.find((w) => w.id === CLIENT_WS)).toMatchObject({ name: "Ambika Portland", city: "Portland", owner_user_id: CLIENT });
  });

  it("the owner of an attached workspace is its owner of record, so no member can also be", async () => {
    seedClientWorkspace();
    await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: null, label: null, reason: "Client asked for service" });
    db.tables.profiles.find((p) => p.id === CLIENT2)!.manager_id = "AX-CLNT2";
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id: CLIENT_WS, proplaneId: "AX-CLNT2", ownerOfRecord: true })).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses to attach a client workspace that already has a member flagged owner of record", async () => {
    seedClientWorkspace();
    db.tables.account_link_invites.push({ id: "ofr", inviter_user_id: CLIENT, invitee_user_id: CLIENT2, workspace_id: CLIENT_WS, team_role: "property_owner", status: "accepted", is_owner_of_record: true });
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: null, label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.portal_workspaces.find((w) => w.id === CLIENT_WS)!.is_service).toBe(false);
  });

  it("is admin-only, re-derived server-side: a non-admin is refused before anything is read or written", async () => {
    seedClientWorkspace();
    expect(await svc.attachWorkspaceToService(client(), MANAGER, { workspaceId: CLIENT_WS, city: null, label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 403 });
    expect(await svc.listServiceAttachCandidates(client(), MANAGER, "")).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.portal_workspaces[0]).toMatchObject({ is_service: false });
    expect(db.tables.audit_log).toHaveLength(0);
    expect(db.tables.account_link_invites).toHaveLength(0);
  });

  it("refuses a bad id, an unknown workspace, one already on the service, and an unconfigured service owner", async () => {
    seedClientWorkspace();
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: "nope", city: null, label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: "dddddddd-1111-4111-8111-dddddddddddd", city: null, label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 404 });
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: "c".repeat(81), label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 400 });
    expect((await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: null, label: null, reason: "Client asked for service" })).ok).toBe(true);
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: null, label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 409 });
    db.tables.platform_service_settings = [];
    db.tables.portal_workspaces.push({ id: "eeeeeeee-1111-4111-8111-eeeeeeeeeeee", owner_user_id: CLIENT2, name: "Other", is_default: true, is_service: false });
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: "eeeeeeee-1111-4111-8111-eeeeeeeeeeee", city: null, label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 409 });
  });

  it("writes the audit row first: with no audit row nothing changes", async () => {
    seedClientWorkspace();
    db.failInsertOn.add("audit_log");
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: "Seattle", label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 503 });
    expect(db.tables.portal_workspaces.find((w) => w.id === CLIENT_WS)).toMatchObject({ is_service: false, city: null });
    expect(db.tables.account_link_invites).toHaveLength(0);
  });

  it("rolls the flag and any seat it added back when a member cannot be seated", async () => {
    seedClientWorkspace();
    db.failInsertOn.add("account_link_invites");
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: "Seattle", label: "X", reason: "Client asked for service" })).toMatchObject({ ok: false });
    expect(db.tables.portal_workspaces.find((w) => w.id === CLIENT_WS)).toMatchObject({ is_service: false, city: null, name: "Ambika Homes", owner_user_id: CLIENT });
    expect(db.tables.audit_log[0]!.result_summary).toMatchObject({ applied: false });
  });

  it("refuses to seat a service owner who is already on the team with a weaker role", async () => {
    seedClientWorkspace();
    db.tables.account_link_invites.push({ id: "vv", inviter_user_id: CLIENT, invitee_user_id: OWNER, workspace_id: CLIENT_WS, team_role: "viewer", status: "accepted" });
    expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: null, label: null, reason: "Client asked for service" })).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.portal_workspaces.find((w) => w.id === CLIENT_WS)!.is_service).toBe(false);
  });

  it("attaching a workspace the service owner already owns seats only the operator", async () => {
    await svc.createServiceWorkspace(client(), OWNER, { name: "Plain", city: null });
    // An owner's workspace that was not created as a service one.
    db.tables.portal_workspaces.push({ id: "ffffffff-1111-4111-8111-ffffffffffff", owner_user_id: OWNER, name: "Own", is_default: false, is_service: false });
    expect((await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: "ffffffff-1111-4111-8111-ffffffffffff", city: null, label: null, reason: "Client asked for service" })).ok).toBe(true);
    expect(db.tables.account_link_invites.map((l) => l.invitee_user_id)).toEqual([ADMIN_A]);
  });

  it("refuses an attach without a usable reason (400) and writes nothing", async () => {
    seedClientWorkspace();
    for (const reason of [undefined, "", "  ", "ab", "r".repeat(501), 5]) {
      expect(await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: null, label: null, reason })).toMatchObject({ ok: false, status: 400 });
    }
    expect(db.tables.portal_workspaces[0]!.is_service).toBe(false);
    expect(db.tables.audit_log).toHaveLength(0);
    expect(db.tables.account_link_invites).toHaveLength(0);
  });

  it("stores the trimmed reason in the audit row", async () => {
    seedClientWorkspace();
    await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS, city: null, label: null, reason: "  Owner asked us to run it  " });
    expect(db.tables.audit_log[0]!.input_summary).toMatchObject({ reason: "Owner asked us to run it" });
  });

  it("lists attach candidates (never a service workspace), narrowed by a search over workspace and owner", async () => {
    seedClientWorkspace();
    db.tables.portal_workspaces.push({ id: "eeeeeeee-1111-4111-8111-eeeeeeeeeeee", owner_user_id: OUTSIDER, name: "Birch", is_default: true, is_service: false });
    await svc.createServiceWorkspace(client(), ADMIN_A, { name: "Already", city: null });
    const all = await svc.listServiceAttachCandidates(client(), ADMIN_A, "");
    expect(all.ok && all.candidates.map((c) => c.name).sort()).toEqual(["Ambika Homes", "Birch"]);
    const some = await svc.listServiceAttachCandidates(client(), ADMIN_A, "ambika");
    expect(some.ok && some.candidates).toEqual([{ id: CLIENT_WS, name: "Ambika Homes", ownerName: "Name aaaa", ownerEmail: "aaaa@example.com" }]);
  });
});

describe("owner-of-record and team changes leave an audit row first", () => {
  async function made() {
    return ((await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: "Seattle" })) as { id: string }).id;
  }
  const actions = () => db.tables.audit_log.map((r) => r.action);

  it("records create and rename (best effort)", async () => {
    const id = await made();
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id, name: "PropLane Seattle 2", city: "Seattle" })).toEqual({ ok: true });
    expect(actions()).toEqual(["admin_service_create", "admin_service_rename"]);
    expect(db.tables.audit_log[0]).toMatchObject({ actor_user_id: ADMIN_A, landlord_id: OWNER });
  });

  it("creates and renames even when the audit row cannot be written", async () => {
    db.failInsertOn.add("audit_log");
    const id = await made();
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id, name: "Other", city: null })).toEqual({ ok: true });
  });

  it("records an owner-of-record invite, a flag change, a team add and a removal", async () => {
    const id = await made();
    const sent = (await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true })) as { linkId: string };
    expect(await svc.setServiceOwnerOfRecord(client(), ADMIN_A, { id, linkId: sent.linkId, value: false })).toEqual({ ok: true });
    const added = (await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: ADMIN_B })) as { linkId: string };
    expect(await svc.removeServiceTeamMember(client(), ADMIN_A, { id, linkId: added.linkId })).toEqual({ ok: true });
    expect(actions()).toEqual(["admin_service_create", "admin_service_team_invite", "admin_service_team_owner_of_record", "admin_service_team_add", "admin_service_team_remove"]);
    expect(db.tables.audit_log[2]!.input_summary).toMatchObject({ linkId: sent.linkId, ownerOfRecord: false });
  });

  it("refuses 503 and changes nothing when the owner-of-record or team audit row cannot be written", async () => {
    const id = await made();
    const sent = (await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA" })) as { linkId: string };
    const other = await made();
    db.failInsertOn.add("audit_log");
    const links = () => JSON.stringify(db.tables.account_link_invites);
    const before = links();
    expect(await svc.setServiceOwnerOfRecord(client(), ADMIN_A, { id, linkId: sent.linkId, value: true })).toMatchObject({ ok: false, status: 503 });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id: other, proplaneId: "AX-AAAA", ownerOfRecord: true })).toMatchObject({ ok: false, status: 503 });
    expect(await svc.addServiceTeamMember(client(), ADMIN_A, { id, userId: ADMIN_B })).toMatchObject({ ok: false, status: 503 });
    expect(await svc.removeServiceTeamMember(client(), ADMIN_A, { id, linkId: sent.linkId })).toMatchObject({ ok: false, status: 503 });
    expect(links()).toBe(before);
  });
});

describe("a service workspace's work email (<name>homes@, minted on add)", () => {
  const emails = () => db.tables.manager_assistant_emails ?? [];
  async function made(name = "1. Ambika") {
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name, city: "Seattle" });
    return res as { ok: true; id: string; workEmail: { address: string | null; warning?: string } };
  }

  it("mints ambikahomes on create, owned by the service owner, whatever the owner's plan", async () => {
    const res = await made("1. Ambika");
    expect(res.ok).toBe(true);
    expect(res.workEmail.warning).toBeUndefined();
    expect(res.workEmail.address).toMatch(/^ambikahomes@/);
    expect(emails()).toHaveLength(1);
    expect(emails()[0]).toMatchObject({ manager_user_id: OWNER, workspace_id: res.id, mailbox_local: "ambikahomes", provision_state: "active" });
    // Nothing about the owner's communication entitlement was read or needed.
    expect(db.tables.sms_manager_entitlements ?? []).toHaveLength(0);
  });

  it("suffixes a collision and names the next one by its own client", async () => {
    await made("1. Ambika");
    await made("1. Ambika");
    await made("2. Vinod");
    const locals = emails().map((e) => String(e.mailbox_local));
    expect(locals[0]).toBe("ambikahomes");
    expect(locals[1]).toMatch(/^ambikahomes-[a-z0-9]{1,4}$/);
    expect(locals[2]).toBe("vinodhomes");
  });

  it("does not fail the create when the mint fails; it reports a warning", async () => {
    db.failInsertOn.add("manager_assistant_emails");
    const res = await made("1. Ambika");
    expect(res.ok).toBe(true);
    expect(db.tables.portal_workspaces).toHaveLength(1);
    expect(res.workEmail).toMatchObject({ address: null });
    expect(res.workEmail.warning).toBeTruthy();
    expect(emails()).toHaveLength(0);
  });

  it("follows a rename when the address was never customized, and holds the old one as an alias", async () => {
    const res = await made("1. Ambika");
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: res.id, name: "1. Ambika Rao", city: "Seattle" })).toEqual({ ok: true });
    expect(emails()[0]!.mailbox_local).toBe("ambikaraohomes");
    expect(db.tables.manager_assistant_email_aliases).toMatchObject([{ mailbox_local: "ambikahomes", owner_user_id: OWNER }]);
  });

  it("leaves a customized address alone on rename", async () => {
    const res = await made("1. Ambika");
    emails()[0]!.mailbox_local = "frontdesk";
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: res.id, name: "1. Ambika Rao", city: "Seattle" })).toEqual({ ok: true });
    expect(emails()[0]!.mailbox_local).toBe("frontdesk");
    expect(db.tables.manager_assistant_email_aliases ?? []).toHaveLength(0);
  });

  it("does not touch the address when the name is unchanged, and a failed follow never fails the rename", async () => {
    const res = await made("1. Ambika");
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: res.id, name: "1. Ambika", city: "Portland" })).toEqual({ ok: true });
    expect(emails()[0]!.mailbox_local).toBe("ambikahomes");
    db.failUpdateOn.add("manager_assistant_emails");
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: res.id, name: "3. Birch", city: "Portland" })).toEqual({ ok: true });
    expect(db.tables.portal_workspaces[0]!.name).toBe("3. Birch");
  });

  it("mints one on attach when the workspace has none", async () => {
    db.tables.portal_workspaces.push({ id: CLIENT_WS_EMAIL, owner_user_id: CLIENT, name: "Ambika", is_default: true, is_service: false });
    const attached = await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS_EMAIL, city: "Seattle", label: "1. Ambika", reason: "managed now" });
    expect(attached.ok).toBe(true);
    expect(emails()).toMatchObject([{ workspace_id: CLIENT_WS_EMAIL, mailbox_local: "ambikahomes" }]);
  });

  it("NEVER moves an address the workspace already has, even when the label renames it", async () => {
    // The workspace ran self-serve, so `ensureOwnedWorkspaceAssistantEmails` minted `{workspace-slug}@` and that
    // address is already on listings and syndication posts. Attaching must not retire it behind a 30-day alias.
    db.tables.portal_workspaces.push({ id: CLIENT_WS_EMAIL, owner_user_id: CLIENT, name: "Ambika", is_default: true, is_service: false });
    (db.tables.manager_assistant_emails ??= []).push({ id: "e-old", manager_user_id: CLIENT, workspace_id: CLIENT_WS_EMAIL, inbox_token: "tok123456789", mailbox_local: "ambika", provision_state: "active" });
    const attached = await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS_EMAIL, city: "Seattle", label: "1. Ambika", reason: "managed now" });
    expect(attached.ok).toBe(true);
    expect(emails()).toHaveLength(1);
    expect(emails()[0]).toMatchObject({ id: "e-old", mailbox_local: "ambika" });
    expect(db.tables.manager_assistant_email_aliases ?? []).toHaveLength(0);
  });

  it("a later rename does not claim a self-serve-derived address either", async () => {
    db.tables.portal_workspaces.push({ id: CLIENT_WS_EMAIL, owner_user_id: CLIENT, name: "Ambika", is_default: true, is_service: false });
    (db.tables.manager_assistant_emails ??= []).push({ id: "e-old", manager_user_id: CLIENT, workspace_id: CLIENT_WS_EMAIL, inbox_token: "tok123456789", mailbox_local: "ambika", provision_state: "active" });
    await svc.attachWorkspaceToService(client(), ADMIN_A, { workspaceId: CLIENT_WS_EMAIL, city: "Seattle", label: "1. Ambika", reason: "managed now" });
    expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: CLIENT_WS_EMAIL, name: "1. Ambika Rao", city: "Seattle" })).toEqual({ ok: true });
    expect(emails()[0]!.mailbox_local).toBe("ambika");
    expect(db.tables.manager_assistant_email_aliases ?? []).toHaveLength(0);
  });

  describe("staff may change it (the same standing a rename needs)", () => {
    it("authorizes a member with the members right on a service workspace only", async () => {
      const res = await made();
      expect(await svc.authorizeServiceWorkEmailEdit(client(), ADMIN_A, res.id)).toMatchObject({ ok: true });
      expect(await svc.authorizeServiceWorkEmailEdit(client(), ADMIN_B, res.id)).toMatchObject({ ok: false, status: 403 });
      db.tables.account_link_invites.push({ id: "viewer-link", inviter_user_id: OWNER, invitee_user_id: ADMIN_B, workspace_id: res.id, team_role: "viewer", status: "accepted" });
      expect(await svc.authorizeServiceWorkEmailEdit(client(), ADMIN_B, res.id)).toMatchObject({ ok: false, status: 403 });
      db.tables.portal_workspaces.push({ id: "99999999-9999-4999-8999-999999999999", owner_user_id: ADMIN_A, name: "Plain", is_service: false });
      expect(await svc.authorizeServiceWorkEmailEdit(client(), ADMIN_A, "99999999-9999-4999-8999-999999999999")).toMatchObject({ ok: false, status: 404 });
    });

    it("sets the address, audit row first, holding the old one as an alias", async () => {
      const res = await made();
      const set = await svc.setServiceWorkspaceWorkEmail(client(), ADMIN_A, { workspaceId: res.id, local: "ambika-front" });
      expect(set).toMatchObject({ ok: true });
      expect(emails()[0]!.mailbox_local).toBe("ambika-front");
      expect(db.tables.audit_log.map((r) => r.action)).toEqual(["admin_service_create", "admin_service_work_email"]);
      expect(db.tables.audit_log[1]).toMatchObject({ actor_user_id: ADMIN_A, landlord_id: OWNER });
      expect(db.tables.manager_assistant_email_aliases).toMatchObject([{ mailbox_local: "ambikahomes" }]);
    });

    it("refuses a taken address (409) and a non-member (403) without changing anything", async () => {
      const res = await made();
      await made("2. Vinod");
      expect(await svc.setServiceWorkspaceWorkEmail(client(), ADMIN_A, { workspaceId: res.id, local: "vinodhomes" })).toMatchObject({ ok: false, status: 409, state: "taken" });
      expect(await svc.setServiceWorkspaceWorkEmail(client(), ADMIN_B, { workspaceId: res.id, local: "hijack" })).toMatchObject({ ok: false, status: 403 });
      expect(emails().map((e) => e.mailbox_local)).toEqual(["ambikahomes", "vinodhomes"]);
    });

    it("changes nothing when the audit row cannot be written", async () => {
      const res = await made();
      db.failInsertOn.add("audit_log");
      expect(await svc.setServiceWorkspaceWorkEmail(client(), ADMIN_A, { workspaceId: res.id, local: "ambika-front" })).toMatchObject({ ok: false, status: 503 });
      expect(emails()[0]!.mailbox_local).toBe("ambikahomes");
    });

    it("validates the local BEFORE the audit row: invalid input is a 400 with no audit row and no write", async () => {
      const res = await made();
      const auditBefore = db.tables.audit_log.length;
      for (const local of ["ab", "Bad Name!", "x".repeat(33), "-leading", "", "admin"]) {
        expect(await svc.setServiceWorkspaceWorkEmail(client(), ADMIN_A, { workspaceId: res.id, local })).toMatchObject({ ok: false, status: 400 });
      }
      expect(db.tables.audit_log).toHaveLength(auditBefore);
      expect(emails()[0]!.mailbox_local).toBe("ambikahomes");
    });
  });

  describe("a released alias belongs to its WORKSPACE, not to the owner user every service workspace shares", () => {
    const { checkWorkspaceAssistantMailboxLocal } = mailbox;
    async function renamedAway() {
      const a = await made("1. Ambika");
      const b = await made("2. Vinod");
      // A is renamed: `ambikahomes` is now A's released alias (owner_user_id = the shared OWNER).
      expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: a.id, name: "1. Ambika Rao", city: "Seattle" })).toEqual({ ok: true });
      expect(db.tables.manager_assistant_email_aliases).toMatchObject([{ mailbox_local: "ambikahomes", owner_user_id: OWNER }]);
      return { a, b };
    }

    it("another service workspace under the same owner cannot check or set A's released local", async () => {
      const { a, b } = await renamedAway();
      expect(await checkWorkspaceAssistantMailboxLocal(client(), b.id, "ambikahomes", OWNER)).toMatchObject({ ok: false, state: "taken" });
      expect(await svc.setServiceWorkspaceWorkEmail(client(), ADMIN_A, { workspaceId: b.id, local: "ambikahomes" })).toMatchObject({ ok: false, status: 409, state: "taken" });
      expect(emails().find((e) => e.workspace_id === b.id)!.mailbox_local).toBe("vinodhomes");
      // A's alias is untouched and still routes to A.
      expect(db.tables.manager_assistant_email_aliases).toMatchObject([{ mailbox_local: "ambikahomes", assistant_email_id: emails().find((e) => e.workspace_id === a.id)!.id }]);
    });

    it("A itself can reclaim it, and the alias is dropped", async () => {
      const { a } = await renamedAway();
      expect(await checkWorkspaceAssistantMailboxLocal(client(), a.id, "ambikahomes", OWNER)).toMatchObject({ ok: true, state: "available" });
      expect(await svc.setServiceWorkspaceWorkEmail(client(), ADMIN_A, { workspaceId: a.id, local: "ambikahomes" })).toMatchObject({ ok: true });
      const aliases = (db.tables.manager_assistant_email_aliases ?? []) as Array<{ mailbox_local: string }>;
      expect(aliases.find((r) => r.mailbox_local === "ambikahomes")).toBeUndefined();
    });

    it("B following a rename into A's alias base allocates a suffixed local instead of taking it", async () => {
      const { a, b } = await renamedAway();
      expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: b.id, name: "1. Ambika", city: "Seattle" })).toEqual({ ok: true });
      expect(emails().find((e) => e.workspace_id === b.id)!.mailbox_local).toBe("ambikahomes-2");
      expect(emails().find((e) => e.workspace_id === a.id)!.mailbox_local).toBe("ambikaraohomes");
      expect(db.tables.manager_assistant_email_aliases).toEqual(expect.arrayContaining([expect.objectContaining({ mailbox_local: "ambikahomes" })]));
    });

    it("a freshly minted workspace is not handed a local that is inside another workspace's cooldown", async () => {
      await renamedAway();
      const c = await made("1. Ambika");
      expect(emails().find((e) => e.workspace_id === c.id)!.mailbox_local).not.toBe("ambikahomes");
    });
  });

  describe("a follow-rename leaves the same audit row a staff change does", () => {
    const workEmailAudits = () => db.tables.audit_log.filter((r) => r.action === "admin_service_work_email");

    it("writes one when the address actually moves", async () => {
      const res = await made();
      expect(workEmailAudits()).toHaveLength(0);
      expect(await svc.renameServiceWorkspace(client(), ADMIN_A, { id: res.id, name: "1. Ambika Rao", city: "Seattle" })).toEqual({ ok: true });
      expect(workEmailAudits()).toHaveLength(1);
      expect(workEmailAudits()[0]).toMatchObject({ actor_user_id: ADMIN_A, landlord_id: OWNER });
      expect(JSON.stringify(workEmailAudits()[0])).toContain("ambikaraohomes");
    });

    it("writes none when the address is customized or the name is unchanged", async () => {
      const res = await made();
      emails()[0]!.mailbox_local = "frontdesk";
      await svc.renameServiceWorkspace(client(), ADMIN_A, { id: res.id, name: "1. Ambika Rao", city: "Seattle" });
      await svc.renameServiceWorkspace(client(), ADMIN_A, { id: res.id, name: "1. Ambika Rao", city: "Portland" });
      expect(workEmailAudits()).toHaveLength(0);
    });
  });
});
const CLIENT_WS_EMAIL = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
