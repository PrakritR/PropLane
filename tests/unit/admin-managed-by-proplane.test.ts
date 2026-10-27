/**
 * Admin > Accounts > Managers > "Managed by PropLane...": attach an owner's workspaces one by one, or Combine all into
 * one. Attach is the existing verb (audit first, never moves ownership); Combine moves ONLY the house -> workspace
 * link, audits each move before anything changes, archives the emptied workspaces, and refuses on any failed read.
 * Also: the owner of record's role is editable by a platform admin only (flag preserved, audited), and the + sheet's
 * owner invite seats them as owner of record when accepted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN_A = "22222222-2222-4222-8222-222222222222";
const MANAGER = "44444444-4444-4444-8444-444444444444";
const CLIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_CLIENT = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const WS_A = "cccccccc-1111-4111-8111-cccccccccccc";
const WS_B = "cccccccc-2222-4222-8222-cccccccccccc";
const WS_C = "cccccccc-3333-4333-8333-cccccccccccc";
const WS_OTHER = "cccccccc-4444-4444-8444-cccccccccccc";

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
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true, entitled: false, tier: "free" })),
}));
const sentEmails = vi.hoisted(() => ({ items: [] as Array<{ to: string[]; subject: string; text: string }> }));
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: vi.fn(async (args: { payload: { to: string[]; subject: string; text: string } }) => {
    sentEmails.items.push(args.payload);
    return new Response(JSON.stringify({ id: "captured" }), { status: 200 });
  }),
}));
process.env.RESEND_API_KEY = "re_test_key";

const svc = await import("@/lib/service/service-workspaces.server");
const managed = await import("@/lib/service/managed-by-proplane.server");

let db: ServiceFakeDb;
const client = () => db as never;

const HOUSE_ROWS = () => [
  { id: "house-a1", manager_user_id: CLIENT, workspace_id: WS_A, row_data: { rent: 1 }, lease: "L1" },
  { id: "house-a2", manager_user_id: CLIENT, workspace_id: WS_A, row_data: { rent: 2 }, lease: "L2" },
  { id: "house-b1", manager_user_id: CLIENT, workspace_id: WS_B, row_data: { rent: 3 }, lease: "L3" },
  { id: "house-c1", manager_user_id: CLIENT, workspace_id: WS_C, row_data: { rent: 4 }, lease: "L4" },
  { id: "house-o1", manager_user_id: OTHER_CLIENT, workspace_id: WS_OTHER, row_data: { rent: 5 }, lease: "L5" },
];

function seed() {
  admins = new Set([OWNER, ADMIN_A]);
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    profile_roles: [OWNER, CLIENT, OTHER_CLIENT].map((user_id) => ({ user_id, role: "manager" })),
    profiles: [OWNER, ADMIN_A, MANAGER, CLIENT, OTHER_CLIENT].map((id) => ({
      id,
      full_name: `Name ${id.slice(0, 4)}`,
      email: `${id.slice(0, 4)}@example.com`,
      manager_id: `AX-${id.slice(0, 4).toUpperCase()}`,
    })),
    portal_workspaces: [
      { id: WS_A, owner_user_id: CLIENT, name: "Marc Homes", is_default: true, is_service: false, city: "Tacoma" },
      { id: WS_B, owner_user_id: CLIENT, name: "Marc Rentals", is_default: false, is_service: false, city: null },
      { id: WS_C, owner_user_id: CLIENT, name: "Marc Lofts", is_default: false, is_service: false, city: null },
      { id: WS_OTHER, owner_user_id: OTHER_CLIENT, name: "Someone else", is_default: true, is_service: false, city: null },
    ],
    account_link_invites: [],
    manager_property_records: HOUSE_ROWS(),
    manager_sms_numbers: [],
    workspace_work_numbers: [],
    sms_runtime_config: [],
    audit_log: [],
  });
}

beforeEach(() => {
  sentEmails.items.length = 0;
  seed();
});

const wsRow = (id: string) => db.tables.portal_workspaces.find((w) => w.id === id)!;
const houseRow = (id: string) => db.tables.manager_property_records.find((h) => h.id === id)!;
const auditActions = () => db.tables.audit_log.map((r) => r.action);

describe("the sheet's list of the account's workspaces", () => {
  it("lists the account's own unmanaged workspaces with house counts, never another owner's", async () => {
    const res = await managed.listAccountWorkspacesForManaging(client(), ADMIN_A, CLIENT);
    expect(res.ok && res.workspaces.map((w) => [w.id, w.houseCount])).toEqual([
      [WS_A, 2],
      [WS_B, 1],
      [WS_C, 1],
    ]);
    expect(res.ok && res.managedCount).toBe(0);
  });

  it("leaves out a workspace that is already PropLane-managed (it is counted, not offered) and an archived one", async () => {
    wsRow(WS_B).is_service = true;
    wsRow(WS_C).archived_at = "2026-10-01T00:00:00.000Z";
    const res = await managed.listAccountWorkspacesForManaging(client(), ADMIN_A, CLIENT);
    expect(res.ok && res.workspaces.map((w) => w.id)).toEqual([WS_A]);
    expect(res.ok && res.managedCount).toBe(1);
  });

  it("refuses a non-admin (403), the service owner's own account (409) and an unreadable list (503)", async () => {
    expect(await managed.listAccountWorkspacesForManaging(client(), MANAGER, CLIENT)).toMatchObject({ ok: false, status: 403 });
    expect(await managed.listAccountWorkspacesForManaging(client(), ADMIN_A, OWNER)).toMatchObject({ ok: false, status: 409 });
    db.failOn.portal_workspaces = { code: "XX000", message: "boom" };
    expect(await managed.listAccountWorkspacesForManaging(client(), ADMIN_A, CLIENT)).toMatchObject({ ok: false, status: 503 });
  });
});

describe("Choose workspaces: the existing attach, once per workspace", () => {
  const base = { accountUserId: CLIENT, mode: "pick", city: "Seattle" };

  it("one workspace: flags it, audits first, labels it, keeps the owner and writes no house row", async () => {
    const before = JSON.stringify(db.tables.manager_property_records);
    const res = await managed.manageAccountByProplane(client(), ADMIN_A, { ...base, workspaceIds: [WS_A], label: "Marc - Seattle" });
    expect(res).toMatchObject({ ok: true, attached: [WS_A], moved: [], archived: [] });
    expect(wsRow(WS_A)).toMatchObject({ owner_user_id: CLIENT, is_service: true, city: "Seattle", name: "Marc - Seattle" });
    expect(wsRow(WS_B).is_service).toBe(false);
    expect(JSON.stringify(db.tables.manager_property_records)).toBe(before);
    expect(db.rpcCalls).toEqual([]);
    expect(auditActions()).toEqual(["admin_service_attach"]);
    expect(db.tables.audit_log[0]).toMatchObject({ actor_user_id: ADMIN_A, landlord_id: CLIENT });
  });

  it("several: attaches exactly the chosen ones, a label applying to a single workspace only", async () => {
    const res = await managed.manageAccountByProplane(client(), ADMIN_A, { ...base, workspaceIds: [WS_A, WS_C], label: "ignored" });
    expect(res).toMatchObject({ ok: true, attached: [WS_A, WS_C] });
    expect(wsRow(WS_A)).toMatchObject({ is_service: true, name: "Marc Homes" });
    expect(wsRow(WS_C)).toMatchObject({ is_service: true, name: "Marc Lofts" });
    expect(wsRow(WS_B).is_service).toBe(false);
    expect(auditActions()).toEqual(["admin_service_attach", "admin_service_attach"]);
  });

  it("re-derives ownership: another owner's workspace, an already-managed one and a malformed id are refused before anything is written", async () => {
    expect(await managed.manageAccountByProplane(client(), ADMIN_A, { ...base, workspaceIds: [WS_A, WS_OTHER] })).toMatchObject({ ok: false, status: 404 });
    wsRow(WS_B).is_service = true;
    expect(await managed.manageAccountByProplane(client(), ADMIN_A, { ...base, workspaceIds: [WS_A, WS_B] })).toMatchObject({ ok: false, status: 409 });
    expect(await managed.manageAccountByProplane(client(), ADMIN_A, { ...base, workspaceIds: ["nope"] })).toMatchObject({ ok: false, status: 400 });
    expect(await managed.manageAccountByProplane(client(), ADMIN_A, { ...base, workspaceIds: [WS_A], feePercent: 55 })).toMatchObject({ ok: false, status: 400 });
    expect(wsRow(WS_A).is_service).toBe(false);
    expect(db.tables.audit_log).toEqual([]);
  });

  it("a non-admin gets 403 and nothing changes; a failed read of the account's workspaces changes nothing (503)", async () => {
    expect(await managed.manageAccountByProplane(client(), MANAGER, { ...base, workspaceIds: [WS_A] })).toMatchObject({ ok: false, status: 403 });
    db.failOn.manager_property_records = { code: "XX000", message: "boom" };
    expect(await managed.manageAccountByProplane(client(), ADMIN_A, { ...base, workspaceIds: [WS_A] })).toMatchObject({ ok: false, status: 503 });
    expect(wsRow(WS_A).is_service).toBe(false);
    expect(db.tables.audit_log).toEqual([]);
  });

  it("stops at the first failure and says how many were attached before it", async () => {
    // WS_B already has a member flagged owner of record: attach refuses it (409).
    db.tables.account_link_invites.push({ id: "flag-1", workspace_id: WS_B, is_owner_of_record: true, status: "accepted", inviter_user_id: CLIENT, invitee_user_id: MANAGER });
    const res = await managed.manageAccountByProplane(client(), ADMIN_A, { ...base, workspaceIds: [WS_A, WS_B, WS_C] });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(!res.ok && res.error).toContain("1 of 3 workspaces were attached");
    expect(wsRow(WS_A).is_service).toBe(true);
    expect(wsRow(WS_B).is_service).toBe(false);
    expect(wsRow(WS_C).is_service).toBe(false);
  });
});

describe("Combine all into one", () => {
  const combine = (extra: Record<string, unknown> = {}) =>
    managed.manageAccountByProplane(client(), ADMIN_A, { accountUserId: CLIENT, mode: "combine", workspaceIds: [WS_A, WS_B, WS_C], targetId: WS_B, city: "Seattle", ...extra });

  it("attaches the target, moves ONLY the house -> workspace link of the others' houses into it, audits each move first, archives the emptied (the default one stays listed)", async () => {
    const before = db.tables.manager_property_records.map((h) => ({ ...h }));
    const res = await combine();
    expect(res).toMatchObject({ ok: true, attached: [WS_B], archived: [WS_C], kept: [WS_A] });
    expect(res.ok && res.moved).toEqual([
      { from: WS_A, to: WS_B, houseIds: ["house-a1", "house-a2"] },
      { from: WS_C, to: WS_B, houseIds: ["house-c1"] },
    ]);

    // Only workspace_id changed, on exactly the others' houses; owner, row data and the lease field are as they were.
    for (const after of db.tables.manager_property_records) {
      const was = before.find((h) => h.id === after.id)!;
      const { workspace_id: nowWs, ...rest } = after;
      const { workspace_id: wasWs, ...wasRest } = was;
      expect(rest).toEqual(wasRest);
      if (["house-a1", "house-a2", "house-c1", "house-b1"].includes(String(after.id))) expect(nowWs).toBe(WS_B);
      else expect(nowWs).toBe(wasWs);
    }
    expect(houseRow("house-o1").workspace_id).toBe(WS_OTHER);

    // The target is managed and still the owner's; the emptied ones are archived (not deleted); the owner never moved.
    expect(wsRow(WS_B)).toMatchObject({ owner_user_id: CLIENT, is_service: true });
    expect(wsRow(WS_C).archived_at).toBeTruthy();
    expect(wsRow(WS_A).archived_at).toBeFalsy();
    expect(db.tables.portal_workspaces).toHaveLength(4);

    // One audit row per move, written BEFORE the attach and the move, then stamped applied.
    expect(auditActions()).toEqual(["admin_service_combine_move", "admin_service_combine_move", "admin_service_attach"]);
    const moves = db.tables.audit_log.filter((r) => r.action === "admin_service_combine_move");
    expect(moves.map((m) => (m.input_summary as { fromWorkspaceId: string }).fromWorkspaceId)).toEqual([WS_A, WS_C]);
    expect(moves[0]!.input_summary).toMatchObject({ toWorkspaceId: WS_B, ownerUserId: CLIENT, houseIds: ["house-a1", "house-a2"] });
    expect(moves.every((m) => (m.result_summary as { applied: boolean }).applied === true)).toBe(true);
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["combine_portal_workspaces"]);
  });

  it("is a single call that re-checks ownership itself: a target or source from another owner is refused by the database", async () => {
    const stale = await db.rpc("combine_portal_workspaces", { p_owner: CLIENT, p_target: WS_B, p_sources: [WS_OTHER] });
    expect(stale.error?.code).toBe("23514");
    expect(houseRow("house-o1").workspace_id).toBe(WS_OTHER);
  });

  it("refuses with nothing written when a read fails (houses, then workspaces)", async () => {
    db.failOn.manager_property_records = { code: "XX000", message: "boom" };
    expect(await combine()).toMatchObject({ ok: false, status: 503 });
    delete db.failOn.manager_property_records;
    db.failOn.portal_workspaces = { code: "XX000", message: "boom" };
    expect(await combine()).toMatchObject({ ok: false, status: 503 });
    delete db.failOn.portal_workspaces;
    expect(db.tables.audit_log).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
    expect(wsRow(WS_B).is_service).toBe(false);
    expect(houseRow("house-a1").workspace_id).toBe(WS_A);
  });

  it("refuses 503 and changes nothing when a move's audit row cannot be written", async () => {
    db.failInsertOn.add("audit_log");
    expect(await combine()).toMatchObject({ ok: false, status: 503 });
    expect(db.rpcCalls).toEqual([]);
    expect(wsRow(WS_B).is_service).toBe(false);
    expect(houseRow("house-a1").workspace_id).toBe(WS_A);
    expect(wsRow(WS_C).archived_at).toBeFalsy();
  });

  it("when the move itself fails nothing is moved or archived, and the audit rows say they were not applied", async () => {
    db.failRpc.add("combine_portal_workspaces");
    const res = await combine();
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect(!res.ok && res.error).toContain("nothing was moved");
    expect(houseRow("house-a1").workspace_id).toBe(WS_A);
    expect(houseRow("house-c1").workspace_id).toBe(WS_C);
    expect(wsRow(WS_C).archived_at).toBeFalsy();
    const moves = db.tables.audit_log.filter((r) => r.action === "admin_service_combine_move");
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => (m.result_summary as { applied: boolean }).applied === false)).toBe(true);
  });

  it("needs at least two workspaces and a target among them", async () => {
    expect(await combine({ workspaceIds: [WS_B] })).toMatchObject({ ok: false, status: 400 });
    expect(await combine({ targetId: WS_OTHER })).toMatchObject({ ok: false, status: 400 });
    expect(await combine({ workspaceIds: [WS_A, WS_B, WS_OTHER] })).toMatchObject({ ok: false, status: 404 });
    expect(db.tables.audit_log).toEqual([]);
  });

  it("a non-admin gets 403", async () => {
    expect(await managed.manageAccountByProplane(client(), MANAGER, { accountUserId: CLIENT, mode: "combine", workspaceIds: [WS_A, WS_B], targetId: WS_A, city: null })).toMatchObject({ ok: false, status: 403 });
    expect(db.rpcCalls).toEqual([]);
  });
});

describe("the route: every new verb starts with requireAdminRoute()", () => {
  it("is asserted in the route test (service-team-routes-and-requests) for the verbs below", () => {
    // The route-level 401/403 for these verbs is in tests/unit/admin-managed-by-proplane-route.test.ts.
    expect(typeof managed.manageAccountByProplane).toBe("function");
  });
});

describe("the owner of record's role (Team)", () => {
  async function ownerWorkspace() {
    const created = (await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: "Seattle" })) as { id: string };
    db.tables.manager_property_records.push(
      { id: "svc-h1", manager_user_id: OWNER, workspace_id: created.id },
      { id: "svc-h2", manager_user_id: OWNER, workspace_id: created.id },
    );
    // The database trigger keeps an "all houses" seat's houses current; the fake has none, so say it by hand.
    for (const l of db.tables.account_link_invites) if (l.workspace_id === created.id && l.house_scope === "all") l.assigned_property_ids = ["svc-h1", "svc-h2"];
    const invited = (await svc.inviteServiceClient(client(), ADMIN_A, { id: created.id, proplaneId: "AX-AAAA", ownerOfRecord: true })) as { linkId: string };
    return { id: created.id, linkId: invited.linkId };
  }
  const seat = (linkId: string) => db.tables.account_link_invites.find((l) => l.id === linkId)!;

  it("a platform admin changes the role and houses like any teammate: the flag stays and the change is audited first", async () => {
    const { id, linkId } = await ownerWorkspace();
    const res = await svc.updateServiceTeamAccess(client(), ADMIN_A, { id, linkId, teamRole: "viewer", houseScope: "selected", assignedPropertyIds: ["svc-h1"] });
    expect(res).toEqual({ ok: true });
    expect(seat(linkId)).toMatchObject({ team_role: "viewer", house_scope: "selected", assigned_property_ids: ["svc-h1"], is_owner_of_record: true });
    const audit = db.tables.audit_log.filter((r) => r.action === "admin_service_team_access");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.input_summary).toMatchObject({ linkId, ownerOfRecord: true, previousTeamRole: "property_owner", teamRole: "viewer", houseScope: "selected" });
  });

  it("putting them back to Owner re-stamps the owner shape server-side (every house, owner keys only) and keeps the flag", async () => {
    const { id, linkId } = await ownerWorkspace();
    await svc.updateServiceTeamAccess(client(), ADMIN_A, { id, linkId, teamRole: "viewer", houseScope: "selected", assignedPropertyIds: ["svc-h1"] });
    const res = await svc.updateServiceTeamAccess(client(), ADMIN_A, {
      id,
      linkId,
      teamRole: "property_owner",
      houseScope: "all",
      assignedPropertyIds: ["forged"],
      coManagerPermissions: { properties: { read: true, edit: true } } as never,
    });
    expect(res).toEqual({ ok: true });
    expect(seat(linkId)).toMatchObject({ team_role: "property_owner", house_scope: "selected", assigned_property_ids: ["svc-h1", "svc-h2"], is_owner_of_record: true });
    expect(JSON.stringify(seat(linkId).co_manager_permissions)).not.toContain("properties");
  });

  it("is a platform-admin change only: a workspace Admin who is not one gets 403 and the seat is untouched", async () => {
    const { id, linkId } = await ownerWorkspace();
    // MANAGER is a member with the Admin role on the workspace, but holds no platform admin role.
    db.tables.account_link_invites.push({
      id: "mgr-seat",
      inviter_user_id: OWNER,
      invitee_user_id: MANAGER,
      workspace_id: id,
      status: "accepted",
      team_role: "admin",
      house_scope: "all",
      is_service_seat: true,
      is_owner_of_record: false,
    });
    const before = JSON.stringify(seat(linkId));
    expect(await svc.updateServiceTeamAccess(client(), MANAGER, { id, linkId, teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: false, status: 403 });
    expect(JSON.stringify(seat(linkId))).toBe(before);
  });

  it("refuses 503 and changes nothing when the audit row cannot be written", async () => {
    const { id, linkId } = await ownerWorkspace();
    const before = JSON.stringify(seat(linkId));
    db.failInsertOn.add("audit_log");
    expect(await svc.updateServiceTeamAccess(client(), ADMIN_A, { id, linkId, teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: false, status: 503 });
    expect(JSON.stringify(seat(linkId))).toBe(before);
  });

  it("an ordinary teammate still cannot be given the Owner role through an edit", async () => {
    const { id } = await ownerWorkspace();
    db.tables.account_link_invites.push({
      id: "mate",
      inviter_user_id: OWNER,
      invitee_user_id: MANAGER,
      workspace_id: id,
      status: "accepted",
      team_role: "viewer",
      house_scope: "all",
      is_service_seat: true,
      is_owner_of_record: false,
    });
    expect(await svc.updateServiceTeamAccess(client(), ADMIN_A, { id, linkId: "mate", teamRole: "property_owner", houseScope: "all" })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("the + sheet's owner invite", () => {
  it("an existing account gets a PENDING Property owner membership flagged owner of record (seated when they accept) and the notice", async () => {
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: "Seattle", ownerContact: "client@example.com".replace("client", "aaaa"), ownerRole: "property_owner" });
    expect(res).toMatchObject({ ok: true, ownerInvite: { sent: true, delivery: "account" } });
    const id = (res as { id: string }).id;
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT)).toMatchObject({
      workspace_id: id,
      status: "pending",
      team_role: "property_owner",
      is_owner_of_record: true,
    });
  });

  it("a new email gets a one-use link bound to that email, as Owner, and the email goes out", async () => {
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: "Seattle", ownerOfRecord: "Priya Nair", ownerContact: "Priya@Example.com" });
    expect(res).toMatchObject({ ok: true, ownerInvite: { sent: true, delivery: "link" } });
    const id = (res as { id: string }).id;
    const link = db.tables.manager_invite_links.find((l) => l.workspace_id === id)!;
    expect(link).toMatchObject({ team_role: "property_owner", invitee_email: "priya@example.com", max_uses: 1, used_count: 0 });
    expect(sentEmails.items).toHaveLength(1);
    expect(sentEmails.items[0]!.to).toEqual(["priya@example.com"]);
    // No membership exists until the owner accepts; the redeem that seats them is covered by
    // evidence-service-owner-of-record-1026.test.ts (bound email only, flagged owner of record, Property owner).
    expect(db.tables.account_link_invites.some((l) => l.workspace_id === id && l.is_owner_of_record === true)).toBe(false);
  });

  it("no email creates the workspace and sends nothing; an owner role other than Property owner is refused before anything is created", async () => {
    const plain = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "PropLane Seattle", city: "Seattle" });
    expect(plain).toMatchObject({ ok: true, ownerInvite: null });
    expect(sentEmails.items).toHaveLength(0);
    const count = db.tables.portal_workspaces.length;
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: "X", city: null, ownerContact: "a@b.co", ownerRole: "admin" })).toMatchObject({ ok: false, status: 400 });
    expect(db.tables.portal_workspaces).toHaveLength(count);
  });
});
