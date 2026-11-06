/**
 * PropLane Service team invites (Oct 25): the Invite sheet's role, houses and module levels are validated by the
 * SAME validators `/api/pro/account-links` uses and re-derived server-side; Owner is a role (one per workspace, a
 * second asks to replace); a person with no account is invited by a one-use link the invite page redeems into a
 * PropLane-issued seat; Edit access re-validates; every refusal changes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN_A = "22222222-2222-4222-8222-222222222222";
const ADMIN_B = "33333333-3333-4333-8333-333333333333";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";
const HELPER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const HELPER2 = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const NEWCOMER = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const CLIENT_OWNER = "cccccccc-1111-4111-8111-cccccccccccc";

let admins = new Set<string>();
let strictRoleReadFails = false;
vi.mock("@/lib/auth/admin-role", () => ({
  userHoldsAdminRole: async (_db: unknown, id: string) => admins.has(id),
  userHoldsAdminRoleStrict: async (_db: unknown, id: string) => { if (strictRoleReadFails) throw new Error("role read unavailable"); return admins.has(id); },
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
  // PropLane's own service owner is on no paid plan: a service seat must not need one.
  getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: true, tier: "free" })),
}));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: false as const, tier: "free" as const })),
}));
const sentEmails = vi.hoisted(() => ({ items: [] as Array<{ to: string[]; subject: string; text: string }> }));
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: vi.fn(async (args: { payload: { to: string[]; subject: string; text: string } }) => {
    sentEmails.items.push(args.payload);
    return new Response(JSON.stringify({ id: "captured" }), { status: 200 });
  }),
}));
const notices = vi.hoisted(() => ({ items: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/co-manager-notification.server", () => ({
  notifyCoManagerInviteSent: vi.fn(async (input: Record<string, unknown>) => {
    notices.items.push(input);
  }),
}));
process.env.RESEND_API_KEY = "re_test_key";

const svc = await import("@/lib/service/service-workspaces.server");
const { redeemInviteLink } = await import("@/lib/invite-links/invite-links.server");
const copy = await import("@/lib/co-manager-link-email");

let db: ServiceFakeDb;
const client = () => db as never;
/** auth.users as the redeem sees it: the sign-in email and whether it is confirmed. Default: confirmed `<id4>@example.com`. */
let authUsers: Record<string, { email: string; email_confirmed_at: string | null }> = {};

function seed() {
  authUsers = {};
  admins = new Set([OWNER, ADMIN_A, ADMIN_B]);
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    profile_roles: [OWNER, HELPER, HELPER2, CLIENT_OWNER].map((user_id) => ({ user_id, role: "manager" })),
    profiles: [OWNER, ADMIN_A, ADMIN_B, OUTSIDER, HELPER, HELPER2, NEWCOMER, CLIENT_OWNER].map((id) => ({
      id,
      full_name: `Name ${id.slice(0, 4)}`,
      email: `${id.slice(0, 4)}@example.com`,
      manager_id: `AX-${id.slice(0, 4).toUpperCase()}`,
    })),
    portal_workspaces: [],
    account_link_invites: [],
    manager_property_records: [],
    manager_invite_links: [],
    manager_invite_link_redemptions: [],
    manager_sms_numbers: [],
    workspace_work_numbers: [],
    sms_runtime_config: [],
    audit_log: [],
  });
  // Auth lookups the owner-only provisioning at redeem makes.
  (db as unknown as { auth: unknown }).auth = {
    admin: {
      getUserById: async (id: string) => ({
        data: {
          user: {
            email: authUsers[id]?.email ?? `${id.slice(0, 4)}@example.com`,
            email_confirmed_at: authUsers[id] ? authUsers[id]!.email_confirmed_at : "2026-10-01T00:00:00Z",
            user_metadata: { full_name: "New Owner" },
          },
        },
      }),
    },
  };
}

/** The database trigger keeps an "all houses" seat's houses current; the fake has no triggers, so say it by hand. */
function seatHouses(workspaceId: string) {
  const houses = db.tables.manager_property_records.filter((h) => h.workspace_id === workspaceId).map((h) => h.id);
  for (const l of db.tables.account_link_invites) if (l.workspace_id === workspaceId && l.house_scope === "all") l.assigned_property_ids = houses;
}

async function made(name = "1. Ambika") {
  const res = (await svc.createServiceWorkspace(client(), ADMIN_A, { name, city: "Seattle" })) as { id: string };
  db.tables.manager_property_records.push(
    { id: "house-a", manager_user_id: OWNER, workspace_id: res.id },
    { id: "house-b", manager_user_id: OWNER, workspace_id: res.id },
    { id: "house-x", manager_user_id: OWNER, workspace_id: "another-workspace" },
  );
  seatHouses(res.id);
  return res.id;
}

beforeEach(() => {
  sentEmails.items.length = 0;
  notices.items.length = 0;
  strictRoleReadFails = false;
  seed();
});

describe("a teammate's role, houses and module levels", () => {
  it("stores a Viewer on one house with Payments at View, validated by the manager-invite validators", async () => {
    const id = await made();
    const res = await svc.inviteServiceClient(client(), ADMIN_A, {
      id,
      proplaneId: "AX-AAAA",
      teamRole: "custom",
      houseScope: "selected",
      assignedPropertyIds: ["house-a"],
      coManagerPermissions: { payments: { read: true, notification: true } },
      propertyCoManagerPermissions: { "house-a": { payments: { read: true, notification: true } } },
    });
    expect(res).toMatchObject({ ok: true, delivery: "account" });
    const row = db.tables.account_link_invites.find((l) => l.invitee_user_id === HELPER)!;
    expect(row).toMatchObject({
      inviter_user_id: OWNER,
      workspace_id: id,
      team_role: "custom",
      house_scope: "selected",
      assigned_property_ids: ["house-a"],
      status: "pending",
      is_service_seat: true,
      is_owner_of_record: false,
    });
    expect(row.property_co_manager_permissions).toEqual({ "house-a": { payments: { read: true, notification: true } } });
    expect(JSON.stringify(row.co_manager_permissions)).not.toMatch(/"(edit|delete)":true/);
  });

  it("a named role rewrites the map: a forged Viewer carrying Edit on everything grants only what Viewer does", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, {
      id,
      proplaneId: "AX-AAAA",
      teamRole: "viewer",
      houseScope: "all",
      coManagerPermissions: { payments: true, financials: true },
      propertyCoManagerPermissions: { "house-a": { payments: true, financials: true } },
    });
    const row = db.tables.account_link_invites.find((l) => l.invitee_user_id === HELPER)!;
    expect(row.team_role).toBe("viewer");
    expect(JSON.stringify(row.property_co_manager_permissions)).not.toMatch(/"edit":true|"delete":true/);
  });

  it("re-derives the houses: 'all' is this workspace's houses, a house of another workspace is refused", async () => {
    const id = await made();
    expect(
      await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "viewer", houseScope: "selected", assignedPropertyIds: ["house-x"] }),
    ).toMatchObject({ ok: false, status: 400, error: "Choose houses from this workspace only." });
    expect(
      await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "viewer", houseScope: "selected", assignedPropertyIds: ["house-a", "house-x"] }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "viewer", houseScope: "selected", assignedPropertyIds: [] })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(db.tables.account_link_invites.filter((l) => l.status === "pending")).toHaveLength(0);
    // "All houses" ignores whatever ids the body names and takes the workspace's own.
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "viewer", houseScope: "all", assignedPropertyIds: ["house-x"] });
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === HELPER)).toMatchObject({
      house_scope: "all",
      assigned_property_ids: ["house-a", "house-b"],
    });
  });

  it("refuses an unknown role, Owner smuggled in as a team role, and a role above the operator's own", async () => {
    const id = await made();
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "god" })).toMatchObject({ ok: false, status: 400 });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "property_owner", houseScope: "all" })).toMatchObject({ ok: false, status: 400 });
    // An Admin seat may hand out Admin but never the legacy Full stamp above it.
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "full", houseScope: "all" })).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.account_link_invites.filter((l) => l.status === "pending")).toHaveLength(0);
  });

  it("refuses an operator who is not on the team and one who cannot manage members; nothing is written", async () => {
    const id = await made();
    expect(await svc.inviteServiceClient(client(), ADMIN_B, { id, proplaneId: "AX-AAAA", teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: false, status: 403 });
    db.tables.account_link_invites.push({ id: "77777777-1111-4111-8111-777777777777", inviter_user_id: OWNER, invitee_user_id: ADMIN_B, workspace_id: id, team_role: "viewer", status: "accepted" });
    expect(await svc.inviteServiceClient(client(), ADMIN_B, { id, proplaneId: "AX-AAAA", teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: false, status: 403 });
    expect(await svc.updateServiceTeamAccess(client(), ADMIN_B, { id, linkId: "77777777-1111-4111-8111-777777777777", teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.account_link_invites.filter((l) => l.status === "pending")).toHaveLength(0);
  });

  it("sends the invite notice (email, inbox, text to a verified phone) for an account that exists", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "leasing", houseScope: "all" });
    await vi.waitFor(() => expect(notices.items).toHaveLength(1));
    expect(notices.items[0]).toMatchObject({
      inviterUserId: OWNER,
      inviteeUserId: HELPER,
      workspaceName: "1. Ambika",
      ownerInvite: false,
    });
    expect(String(notices.items[0]!.inviteId)).toBe(String(db.tables.account_link_invites.find((l) => l.invitee_user_id === HELPER)!.id));
  });
});

describe("Edit access (team-access)", () => {
  async function seated() {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", teamRole: "viewer", houseScope: "all" });
    return { id, row: db.tables.account_link_invites.find((l) => l.invitee_user_id === HELPER)! };
  }

  it("changes the role, houses and levels with the same validation, keeps the PropLane seat flag, and audits first", async () => {
    const { id, row } = await seated();
    const res = await svc.updateServiceTeamAccess(client(), ADMIN_A, {
      id,
      linkId: String(row.id),
      teamRole: "custom",
      houseScope: "selected",
      assignedPropertyIds: ["house-b"],
      coManagerPermissions: { services: { read: true, edit: true, notification: true } },
      propertyCoManagerPermissions: { "house-b": { services: { read: true, edit: true, notification: true } } },
    });
    expect(res).toEqual({ ok: true });
    expect(row).toMatchObject({ team_role: "custom", house_scope: "selected", assigned_property_ids: ["house-b"], is_service_seat: true });
    expect(row.property_co_manager_permissions).toEqual({ "house-b": { services: { read: true, edit: true, notification: true } } });
    expect(db.tables.audit_log.some((a) => a.action === "admin_service_team_access")).toBe(true);
  });

  it("refuses a house of another workspace, a link of another workspace, the owner's seat and a non-admin", async () => {
    const { id, row } = await seated();
    expect(
      await svc.updateServiceTeamAccess(client(), ADMIN_A, { id, linkId: String(row.id), teamRole: "viewer", houseScope: "selected", assignedPropertyIds: ["house-x"] }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(row).toMatchObject({ team_role: "viewer", house_scope: "all" });
    const other = await made("2. Vinod");
    expect(await svc.updateServiceTeamAccess(client(), ADMIN_A, { id: other, linkId: String(row.id), teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: false, status: 404 });
    expect(await svc.updateServiceTeamAccess(client(), ADMIN_A, { id, linkId: "not-a-uuid", teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: false, status: 400 });
    // The owner of record is editable like a teammate (a platform admin only, flag kept: admin-managed-by-proplane.test.ts);
    // a role is still never invented from the body, and nobody else can.
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-CCCC", ownerOfRecord: true });
    const ownerRow = db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT_OWNER)!;
    expect(await svc.updateServiceTeamAccess(client(), ADMIN_A, { id, linkId: String(ownerRow.id), teamRole: "viewer", houseScope: "all" })).toEqual({ ok: true });
    expect(ownerRow).toMatchObject({ team_role: "viewer", is_owner_of_record: true });
    expect(await svc.updateServiceTeamAccess(client(), OUTSIDER, { id, linkId: String(ownerRow.id), teamRole: "admin", houseScope: "all" })).toMatchObject({ ok: false, status: 403 });
    expect(ownerRow).toMatchObject({ team_role: "viewer", is_owner_of_record: true });
    expect(await svc.updateServiceTeamAccess(client(), OUTSIDER, { id, linkId: String(row.id), teamRole: "admin", houseScope: "all" })).toMatchObject({ ok: false, status: 403 });
  });

  it("will not demote the workspace's last admin", async () => {
    const id = await made();
    const adminRow = db.tables.account_link_invites.find((l) => l.invitee_user_id === ADMIN_A)!;
    expect(adminRow.team_role).toBe("admin");
    // ADMIN_A is the only accepted admin seat; the operator editing themselves cannot leave none.
    const res = await svc.updateServiceTeamAccess(client(), ADMIN_A, { id, linkId: String(adminRow.id), teamRole: "viewer", houseScope: "all" });
    expect(res).toMatchObject({ ok: false, status: 403, error: expect.stringMatching(/at least one admin/) });
    expect(adminRow.team_role).toBe("admin");
    // The workspace's own owner may (the rule only protects a workspace from having none when the owner delegated it).
    const byOwner = await svc.updateServiceTeamAccess(client(), OWNER, { id, linkId: String(adminRow.id), teamRole: "viewer", houseScope: "all" });
    expect(byOwner).toEqual({ ok: true });
    expect(adminRow.team_role).toBe("viewer");
  });
});

describe("the Owner role", () => {
  it("invites the owner of record by PropLane ID as a pending Property owner with the owner notice", async () => {
    const id = await made();
    const res = await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-CCCC", ownerOfRecord: true });
    expect(res).toMatchObject({ ok: true, delivery: "account", ownerReplaced: false });
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT_OWNER)).toMatchObject({
      team_role: "property_owner",
      is_owner_of_record: true,
      house_scope: "selected",
      assigned_property_ids: ["house-a", "house-b"],
      status: "pending",
    });
    await vi.waitFor(() => expect(notices.items).toHaveLength(1));
    expect(notices.items[0]).toMatchObject({ ownerInvite: true, workspaceName: "1. Ambika" });
    const list = await svc.listServiceTeam(client(), ADMIN_A, id);
    expect(list.ok && list.members.find((m) => m.userId === CLIENT_OWNER)).toMatchObject({ ownerOfRecord: true, status: "pending", role: "property_owner" });
  });

  it("a second owner asks to replace; confirming replaces the first (cancelled, audited) and invites the new one", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-CCCC", ownerOfRecord: true });
    const asked = await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true });
    expect(asked).toMatchObject({ ok: false, status: 409, code: "owner_exists" });
    expect((asked as { ownerName?: string }).ownerName).toBeTruthy();
    // Nothing moved while it was only asked.
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT_OWNER)!.status).toBe("pending");
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === HELPER)).toBe(false);
    const replaced = await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true, replaceOwner: true });
    expect(replaced).toMatchObject({ ok: true, ownerReplaced: true });
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT_OWNER)).toMatchObject({ status: "cancelled" });
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === HELPER)).toMatchObject({ is_owner_of_record: true, status: "pending" });
    expect(db.tables.account_link_invites.filter((l) => l.is_owner_of_record === true && l.status !== "cancelled")).toHaveLength(1);
    expect(db.tables.audit_log.some((a) => a.action === "admin_service_owner_replaced")).toBe(true);
  });

  it("the client who owns an attached workspace is its owner of record and cannot be replaced", async () => {
    const id = "dddddddd-1111-4111-8111-dddddddddddd";
    db.tables.portal_workspaces.push({ id, owner_user_id: CLIENT_OWNER, name: "Ambika Homes", is_default: true, is_service: true, city: null });
    db.tables.account_link_invites.push({ id: "eeeeeeee-1111-4111-8111-eeeeeeeeeeee", inviter_user_id: CLIENT_OWNER, invitee_user_id: ADMIN_A, workspace_id: id, team_role: "admin", status: "accepted", is_service_seat: true });
    const res = await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-AAAA", ownerOfRecord: true, replaceOwner: true });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect((res as { code?: string }).code).toBeUndefined();
  });

  it("refuses owner assignment when the target admin role cannot be read", async () => {
    const id = await made();
    strictRoleReadFails = true;
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-CCCC", ownerOfRecord: true })).toMatchObject({ ok: false, status: 503 });
    expect(db.tables.account_link_invites.some((row) => row.invitee_user_id === CLIENT_OWNER)).toBe(false);
  });

  it("a PropLane admin can never be invited as the owner", async () => {
    const id = await made();
    db.tables.profile_roles.push({ user_id: ADMIN_B, role: "manager" });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, proplaneId: "AX-3333", ownerOfRecord: true })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("New workspace: the owner's name and email or PropLane ID", () => {
  it("creates with the owner's name, then sends the owner invite to the email (same function as the Team sheet)", async () => {
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "Seattle Homes", city: "Seattle", ownerOfRecord: "Ambika Rao", ownerContact: "ambika@example.com" });
    expect(res).toMatchObject({ ok: true, ownerInvite: { sent: true, delivery: "link" } });
    expect(db.tables.portal_workspaces[0]).toMatchObject({ name: "Seattle Homes", owner_of_record_name: "Ambika Rao" });
    expect(sentEmails.items).toHaveLength(1);
    expect(sentEmails.items[0]).toMatchObject({ to: ["ambika@example.com"], subject: "PropLane manages Seattle Homes for you" });
    expect(sentEmails.items[0]!.text).toContain("Hi Ambika,");
    expect(db.tables.manager_invite_links[0]).toMatchObject({ team_role: "property_owner" });
  });

  it("a PropLane ID of an existing account gets the pending owner seat and the owner notice", async () => {
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "Seattle Homes", city: null, ownerOfRecord: "Ambika", ownerContact: "AX-CCCC" });
    expect(res).toMatchObject({ ok: true, ownerInvite: { sent: true, delivery: "account" } });
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === CLIENT_OWNER)).toMatchObject({ is_owner_of_record: true, status: "pending" });
    await vi.waitFor(() => expect(notices.items[0]).toMatchObject({ ownerInvite: true }));
  });

  it("leaving the email blank sends nothing; the name alone still fills the owner label", async () => {
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "Seattle Homes", city: null, ownerOfRecord: "Ambika Rao" });
    expect(res).toMatchObject({ ok: true, ownerInvite: null });
    expect(sentEmails.items).toHaveLength(0);
    expect(db.tables.manager_invite_links).toHaveLength(0);
    expect(db.tables.portal_workspaces[0]!.owner_of_record_name).toBe("Ambika Rao");
  });

  it("a malformed email is refused before anything is created; a failed invite leaves the workspace", async () => {
    expect(await svc.createServiceWorkspace(client(), ADMIN_A, { name: "X", city: null, ownerContact: "not@valid" })).toMatchObject({ ok: false, status: 400 });
    expect(db.tables.portal_workspaces).toHaveLength(0);
    const res = await svc.createServiceWorkspace(client(), ADMIN_A, { name: "Seattle Homes", city: null, ownerContact: "AX-NOPE" });
    expect(res).toMatchObject({ ok: true, ownerInvite: { sent: false } });
    expect(db.tables.portal_workspaces).toHaveLength(1);
  });
});

describe("someone with no account yet", () => {
  async function inviteNewOwner(replaceOwner = false) {
    const id = await made();
    const res = await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "Priya@Example.com", inviteeName: "Priya Nair", ownerOfRecord: true, replaceOwner });
    return { id, res };
  }

  it("emails a one-use invite link with the owner copy: subject, body and no long dashes", async () => {
    const { id, res } = await inviteNewOwner();
    expect(res).toMatchObject({ ok: true, delivery: "link" });
    expect(db.tables.account_link_invites.filter((l) => l.status === "pending")).toHaveLength(0);
    const link = db.tables.manager_invite_links[0]!;
    expect(link).toMatchObject({ workspace_id: id, owner_user_id: OWNER, kind: "manager", team_role: "property_owner", max_uses: 1, label: "Service invite · priya@example.com" });
    expect(sentEmails.items).toHaveLength(1);
    const mail = sentEmails.items[0]!;
    expect(mail.to).toEqual(["priya@example.com"]);
    expect(mail.subject).toBe("PropLane manages 1. Ambika for you");
    expect(mail.text).toMatch(/^Hi Priya,\n\nPropLane has set up 1\. Ambika for your homes\. Create your account to see rent, payouts and services: https?:\/\/\S+\/invite\/\S+/);
    expect(mail.text).not.toMatch(/[–—]/);
    expect(mail.subject).not.toMatch(/[–—]/);
  });

  it("the owner copy builders read the way the plan says", () => {
    expect(copy.ownerInviteSubject("Seattle Homes")).toBe("PropLane manages Seattle Homes for you");
    expect(copy.buildOwnerInviteBody({ ownerName: "Ambika Rao", workspaceName: "Seattle Homes", acceptUrl: "https://x/invite/t" })).toContain(
      "Hi Ambika,\n\nPropLane has set up Seattle Homes for your homes. Create your account to see rent, payouts and services: https://x/invite/t",
    );
    expect(copy.buildOwnerInviteBody({ workspaceName: "Seattle Homes", acceptUrl: "u" })).toContain("Hi there,");
    expect(copy.buildOwnerInviteText({ workspaceName: "Seattle Homes", acceptUrl: "https://x/invite/t" })).toBe(
      "PropLane: Seattle Homes is ready. Create your account to see your homes: https://x/invite/t",
    );
  });

  it("shows the pending owner as 'Invited' in the team list, and Remove turns the link off", async () => {
    const { id } = await inviteNewOwner();
    const team = await svc.listServiceTeam(client(), ADMIN_A, id);
    const row = team.ok ? team.members.find((m) => m.delivery === "link")! : null;
    expect(row).toMatchObject({ status: "pending", ownerOfRecord: true, role: "property_owner", email: "priya@example.com" });
    expect(await svc.removeServiceTeamMember(client(), ADMIN_A, { id, inviteLinkId: row!.linkId })).toEqual({ ok: true });
    expect(db.tables.manager_invite_links[0]!.revoked_at).toBeTruthy();
    const after = await svc.listServiceTeam(client(), ADMIN_A, id);
    expect(after.ok && after.members.some((m) => m.delivery === "link")).toBe(false);
    // A link id of another workspace is a 404, never a revoke.
    expect(await svc.removeServiceTeamMember(client(), ADMIN_A, { id, inviteLinkId: "00000000-0000-4000-8000-00000000ffff" })).toMatchObject({ ok: false, status: 404 });
  });

  it("a second owner invite asks to replace, then revokes the first link", async () => {
    const { id } = await inviteNewOwner();
    const asked = await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "second@example.com", ownerOfRecord: true });
    expect(asked).toMatchObject({ ok: false, status: 409, code: "owner_exists", ownerName: "priya@example.com" });
    const replaced = await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "second@example.com", ownerOfRecord: true, replaceOwner: true });
    expect(replaced).toMatchObject({ ok: true, delivery: "link", ownerReplaced: true });
    expect(db.tables.manager_invite_links.filter((l) => !l.revoked_at)).toHaveLength(1);
    expect(db.tables.manager_invite_links.find((l) => !l.revoked_at)!.label).toBe("Service invite · second@example.com");
  });

  it("refuses a duplicate email and tells the operator when the email could not be sent (the link is turned off)", async () => {
    const id = await made();
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "new@example.com", teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: true, delivery: "link" });
    expect(await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "NEW@example.com", teamRole: "viewer", houseScope: "all" })).toMatchObject({ ok: false, status: 409 });
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const failed = await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "other@example.com", teamRole: "viewer", houseScope: "all" });
    process.env.RESEND_API_KEY = saved;
    expect(failed).toMatchObject({ ok: false, status: 502 });
    expect(db.tables.manager_invite_links.find((l) => l.label === "Service invite · other@example.com")!.revoked_at).toBeTruthy();
  });

  it("brand-new email, end to end: the link is redeemed by the new account into an owner-of-record seat, with no plan", async () => {
    const { id } = await inviteNewOwner();
    const mail = sentEmails.items[0]!;
    const token = /\/invite\/([^\s]+)/.exec(mail.text)![1]!;
    // The person opens the link, creates an account on the invite page (a profile now exists), and accepts.
    authUsers[NEWCOMER] = { email: "priya@example.com", email_confirmed_at: "2026-10-25T00:00:00Z" };
    const redeemed = await redeemInviteLink(client(), { token, redeemerUserId: NEWCOMER });
    expect(redeemed).toMatchObject({ ok: true, kind: "manager", workspaceId: id, alreadyRedeemed: false });
    const seat = db.tables.account_link_invites.find((l) => l.invitee_user_id === NEWCOMER)!;
    expect(seat).toMatchObject({
      inviter_user_id: OWNER,
      workspace_id: id,
      team_role: "property_owner",
      status: "accepted",
      house_scope: "selected",
      is_owner_of_record: true,
      is_service_seat: false,
    });
    // Owner keys only; the Property portal account was provisioned (a manager role row, no plan).
    expect(JSON.stringify(seat.property_co_manager_permissions)).toMatch(/ownerPerformance/);
    expect(JSON.stringify(seat.property_co_manager_permissions)).not.toMatch(/"(properties|payments|residents)"/);
    expect(db.tables.profile_roles.some((r) => r.user_id === NEWCOMER && r.role === "manager")).toBe(true);
    // One use, spent. A second person with the same link gets nothing.
    expect(db.tables.manager_invite_links[0]!.used_count).toBe(1);
    expect(await redeemInviteLink(client(), { token, redeemerUserId: HELPER2 })).toMatchObject({ ok: false, status: 410 });
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === HELPER2)).toBe(false);
  });

  it("an owner link that is not bound to an email (a share link, or one from before the rule) never makes an owner of record", async () => {
    await inviteNewOwner();
    const mail = sentEmails.items[0]!;
    const token = /\/invite\/([^\s]+)/.exec(mail.text)![1]!;
    db.tables.manager_invite_links[0]!.invitee_email = null;
    authUsers[NEWCOMER] = { email: "priya@example.com", email_confirmed_at: "2026-10-25T00:00:00Z" };
    expect(await redeemInviteLink(client(), { token, redeemerUserId: NEWCOMER })).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === NEWCOMER)).toBe(false);
    expect(db.tables.manager_invite_links[0]!.used_count ?? 0).toBe(0);
  });

  it("a teammate invited by email redeems into a PropLane-issued seat with the validated role and houses", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, {
      id,
      email: "mate@example.com",
      teamRole: "leasing",
      houseScope: "selected",
      assignedPropertyIds: ["house-a"],
    });
    const token = /\/invite\/([^\s]+)/.exec(sentEmails.items[0]!.text)![1]!;
    expect(sentEmails.items[0]!.subject).toBe("Join 1. Ambika on PropLane");
    db.tables.profile_roles.push({ user_id: NEWCOMER, role: "manager" });
    authUsers[NEWCOMER] = { email: "mate@example.com", email_confirmed_at: "2026-10-25T00:00:00Z" };
    expect(await redeemInviteLink(client(), { token, redeemerUserId: NEWCOMER })).toMatchObject({ ok: true });
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === NEWCOMER)).toMatchObject({
      team_role: "leasing",
      house_scope: "selected",
      assigned_property_ids: ["house-a"],
      status: "accepted",
      is_service_seat: true,
      is_owner_of_record: false,
    });
  });

  it("the plan gate and the service flags apply only to a workspace PropLane owns; a client's own invite link is unchanged", async () => {
    // A manager's own (non-service) workspace: a Free owner cannot have a redeemed link, and no service flags are set.
    const own = "ffffffff-1111-4111-8111-ffffffffffff";
    db.tables.portal_workspaces.push({ id: own, owner_user_id: HELPER, name: "Mine", is_default: true, is_service: false });
    db.tables.manager_invite_links.push({
      id: "99999999-1111-4111-8111-999999999999",
      owner_user_id: HELPER,
      workspace_id: own,
      kind: "manager",
      token_hash: (await import("@/lib/invite-links/invite-links.server")).hashInviteLinkToken("tok-own"),
      assigned_property_ids: [],
      property_permissions: {},
      max_uses: 1,
      used_count: 0,
      team_role: "viewer",
      house_scope: "all",
      created_at: "2026-10-01T00:00:00Z",
    });
    const res = await redeemInviteLink(client(), { token: "tok-own", redeemerUserId: HELPER2 });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === HELPER2)).toBe(false);
  });
});

describe("a service invite link is bound to the email it was sent to", () => {
  const OTHER_MSG = "This invite was sent to another email. Sign in with that email to accept it.";

  async function ownerLink() {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "Priya@Example.com", inviteeName: "Priya Nair", ownerOfRecord: true });
    const token = /\/invite\/([^\s]+)/.exec(sentEmails.items[0]!.text)![1]!;
    return { id, token };
  }
  const seatFor = (user: string) => db.tables.account_link_invites.find((l) => l.invitee_user_id === user);

  it("stores the invited email, lowercase, on the minted link", async () => {
    await ownerLink();
    expect(db.tables.manager_invite_links[0]!.invitee_email).toBe("priya@example.com");
  });

  it("the matching confirmed account redeems it into the owner-of-record seat", async () => {
    const { id, token } = await ownerLink();
    authUsers[NEWCOMER] = { email: "PRIYA@example.com", email_confirmed_at: "2026-10-25T00:00:00Z" };
    expect(await redeemInviteLink(client(), { token, redeemerUserId: NEWCOMER })).toMatchObject({ ok: true, workspaceId: id });
    expect(seatFor(NEWCOMER)).toMatchObject({ is_owner_of_record: true, status: "accepted" });
    expect(db.tables.manager_invite_links[0]!.used_count).toBe(1);
  });

  it("a different account is refused with the plain message and the link stays unconsumed", async () => {
    const { token } = await ownerLink();
    authUsers[HELPER2] = { email: "someone.else@example.com", email_confirmed_at: "2026-10-25T00:00:00Z" };
    const res = await redeemInviteLink(client(), { token, redeemerUserId: HELPER2 });
    expect(res).toMatchObject({ ok: false, status: 403, error: OTHER_MSG });
    expect(seatFor(HELPER2)).toBeUndefined();
    expect(db.tables.manager_invite_links[0]!.used_count).toBe(0);
    expect(db.tables.manager_invite_link_redemptions).toHaveLength(0);
    // The right person can still accept afterwards.
    authUsers[NEWCOMER] = { email: "priya@example.com", email_confirmed_at: "2026-10-25T00:00:00Z" };
    expect(await redeemInviteLink(client(), { token, redeemerUserId: NEWCOMER })).toMatchObject({ ok: true });
  });

  it("an unconfirmed email is refused even when it matches, and nothing is spent", async () => {
    const { token } = await ownerLink();
    authUsers[NEWCOMER] = { email: "priya@example.com", email_confirmed_at: null };
    const res = await redeemInviteLink(client(), { token, redeemerUserId: NEWCOMER });
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(seatFor(NEWCOMER)).toBeUndefined();
    expect(db.tables.manager_invite_links[0]!.used_count).toBe(0);
  });

  it("a teammate link is bound the same way", async () => {
    const id = await made();
    await svc.inviteServiceClient(client(), ADMIN_A, { id, email: "mate@example.com", teamRole: "leasing", houseScope: "selected", assignedPropertyIds: ["house-a"] });
    const token = /\/invite\/([^\s]+)/.exec(sentEmails.items[0]!.text)![1]!;
    db.tables.profile_roles.push({ user_id: HELPER2, role: "manager" });
    authUsers[HELPER2] = { email: "other@example.com", email_confirmed_at: "2026-10-25T00:00:00Z" };
    expect(await redeemInviteLink(client(), { token, redeemerUserId: HELPER2 })).toMatchObject({ ok: false, status: 403, error: OTHER_MSG });
    expect(db.tables.manager_invite_links[0]!.used_count).toBe(0);
  });

  it("the preview names the invited address so the invite page can lock its sign-up to it", async () => {
    const { token } = await ownerLink();
    const { previewInviteLink } = await import("@/lib/invite-links/invite-links.server");
    expect(await previewInviteLink(client(), token)).toMatchObject({ inviteeEmail: "priya@example.com" });
  });

  it("a link with no bound email (every non-service link) behaves exactly as before, whoever the redeemer is", async () => {
    const id = await made();
    db.tables.manager_invite_links.push({
      id: "99999999-2222-4222-8222-999999999999",
      owner_user_id: OWNER,
      workspace_id: id,
      kind: "manager",
      token_hash: (await import("@/lib/invite-links/invite-links.server")).hashInviteLinkToken("tok-plain-link"),
      assigned_property_ids: ["house-a"],
      property_permissions: {},
      max_uses: 1,
      used_count: 0,
      team_role: "viewer",
      house_scope: "selected",
      created_at: "2026-10-01T00:00:00Z",
    });
    db.tables.profile_roles.push({ user_id: HELPER2, role: "manager" });
    authUsers[HELPER2] = { email: "anyone@example.com", email_confirmed_at: null };
    expect(await redeemInviteLink(client(), { token: "tok-plain-link", redeemerUserId: HELPER2 })).toMatchObject({ ok: true });
  });
});
