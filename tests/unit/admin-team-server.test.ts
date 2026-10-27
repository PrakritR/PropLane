/**
 * Admin team (plan admin-team-1027), server side, over the real service layer and an in-memory database:
 *   * an invite is bound to one email and grants nothing until that exact email redeems it;
 *   * an Overall admin invite needs an Overall admin, at create AND at redeem;
 *   * a workspace admin invites only into workspaces they run, never above their own role;
 *   * the last Overall admin cannot be removed or demoted;
 *   * a workspace admin gets 403 on PropLane-wide admin routes and sees only their own workspace's tile and seats.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PRAKRIT = "22222222-2222-4222-8222-222222222222";
const AARAV = "33333333-3333-4333-8333-333333333333";
const JORDAN = "44444444-4444-4444-8444-444444444444";
const SAM = "55555555-5555-4555-8555-555555555555";
const STRANGER = "66666666-6666-4666-8666-666666666666";

const state = vi.hoisted(() => ({ signedIn: null as string | null }));
let db: ServiceFakeDb & { auth?: unknown };

const roleHolders = (d: ServiceFakeDb) => (d.tables.profile_roles ?? []).filter((r) => r.role === "admin").map((r) => String(r.user_id));
vi.mock("@/lib/auth/admin-role", () => ({
  userHoldsAdminRole: async (d: ServiceFakeDb, id: string) => roleHolders(d).includes(id),
  listAdminUserIds: async (d: ServiceFakeDb) => roleHolders(d).sort(),
  filterAdminUserIds: async (d: ServiceFakeDb, ids: string[]) => new Set(ids.filter((id) => roleHolders(d).includes(id))),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async (id: string) => roleHolders(db).includes(id) }));
vi.mock("@/lib/manager-access-server", () => ({
  ensureProfileProplaneId: async (_d: unknown, id: string) => ({ ok: true, proplaneId: `AX-${id.slice(0, 4)}`, fullName: `Name ${id.slice(0, 4)}`, email: `${id.slice(0, 4)}@example.com`, role: "admin" }),
}));
vi.mock("@/lib/auth/co-manager-invite-eligibility.server", () => ({ userIsPropertyPortalManager: async () => true }));
vi.mock("@/lib/workspaces/server", () => ({ loadWorkspaces: async () => [] }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.signedIn ? { id: state.signedIn } : null } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
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
process.env.RESEND_API_KEY = "re_test_key";

const svc = await import("@/lib/service/service-workspaces.server");
const team = await import("@/lib/admin-team/admin-team.server");
const invites = await import("@/lib/admin-team/admin-team-invite.server");
const links = await import("@/lib/invite-links/invite-links.server");
const mode = await import("@/lib/service/service-mode.server");
const guard = await import("@/lib/admin-team/admin-team-route.server");
const adminGuard = await import("@/lib/admin/admin-route-guard.server");
const teamRoute = await import("@/app/api/admin/team/route");
const inviteRoute = await import("@/app/api/admin/team/invite/route");

const client = () => db as never;
let AMBIKA = "";
let VINOD = "";

const EMAILS: Record<string, string> = {
  [OWNER]: "owner@example.com",
  [PRAKRIT]: "prakrit@example.com",
  [AARAV]: "aarav@example.com",
  [JORDAN]: "jordan@example.com",
  [SAM]: "sam@example.com",
  [STRANGER]: "stranger@example.com",
};

function signUp(id: string, opts: { confirmed?: boolean } = {}) {
  db.tables.profiles.push({ id, full_name: `Name ${id.slice(0, 4)}`, email: EMAILS[id], manager_id: `AX-${id.slice(0, 4)}`, role: "manager" });
  (db.auth as { users: Map<string, unknown> }).users.set(id, { id, email: EMAILS[id], email_confirmed_at: opts.confirmed === false ? null : "2026-10-27T00:00:00Z", user_metadata: { full_name: `Name ${id.slice(0, 4)}` } });
}

beforeEach(async () => {
  sentEmails.items.length = 0;
  state.signedIn = null;
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    profile_roles: [
      { user_id: OWNER, role: "manager" },
      { user_id: PRAKRIT, role: "admin" },
      { user_id: PRAKRIT, role: "manager" },
    ],
    profiles: [],
    portal_workspaces: [],
    account_link_invites: [],
    manager_property_records: [],
    manager_invite_links: [],
    manager_invite_link_redemptions: [],
    audit_log: [],
    admin_team_grants: [],
    manager_sms_numbers: [],
    workspace_work_numbers: [],
    sms_runtime_config: [],
  }) as ServiceFakeDb & { auth?: unknown };
  const users = new Map<string, unknown>();
  db.auth = { users, admin: { getUserById: async (id: string) => ({ data: { user: users.get(id) ?? null }, error: null }) } };
  for (const id of [OWNER, PRAKRIT, AARAV, JORDAN, SAM, STRANGER]) signUp(id);
  const created = await svc.createServiceWorkspace(client(), PRAKRIT, { name: "1. Ambika", city: "Seattle" });
  const created2 = await svc.createServiceWorkspace(client(), PRAKRIT, { name: "2. Vinod", city: "Seattle" });
  if (!created.ok || !created2.ok) throw new Error("workspace setup failed");
  AMBIKA = created.id;
  VINOD = created2.id;
  db.tables.manager_property_records.push(
    { id: "house-1", manager_user_id: OWNER, workspace_id: AMBIKA, row_data: { buildingName: "5257" } },
    { id: "house-2", manager_user_id: OWNER, workspace_id: AMBIKA, row_data: { buildingName: "5259" } },
    { id: "house-3", manager_user_id: OWNER, workspace_id: VINOD, row_data: { buildingName: "Vinod house" } },
  );
});

async function actorOf(userId: string) {
  return team.resolveAdminTeamActor(client(), userId);
}

/** The token in the last emailed accept link. */
function lastToken(): string {
  const text = sentEmails.items.at(-1)!.text;
  return /\/invite\/([A-Za-z0-9_-]+)/.exec(text)![1]!;
}

async function invite(by: string, input: { email: string; role: string; workspaceIds?: string[]; access?: Record<string, unknown> }) {
  return invites.inviteAdminTeamMember(client(), by, await actorOf(by), {
    email: input.email,
    role: input.role,
    workspaceIds: input.workspaceIds ?? [],
    access: (input.access ?? {}) as never,
  });
}

const redeem = (userId: string, token: string) => links.redeemInviteLink(client(), { token, redeemerUserId: userId });
const auditActions = () => db.tables.audit_log.map((r) => r.action);

describe("an admin invite", () => {
  it("is one use, bound to the email, seven days, and emailed with the admin copy", async () => {
    const res = await invite(PRAKRIT, { email: " Aarav@Example.com ", role: "overall_admin" });
    expect(res).toMatchObject({ ok: true, emailed: true });
    const link = db.tables.manager_invite_links[0]!;
    expect(link).toMatchObject({ kind: "admin", owner_user_id: PRAKRIT, invitee_email: "aarav@example.com", max_uses: 1 });
    expect(link.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const days = (new Date(String(link.expires_at)).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect(sentEmails.items[0]!.subject).toBe("You're invited to PropLane admin");
    expect(sentEmails.items[0]!.to).toEqual(["aarav@example.com"]);
    expect(sentEmails.items[0]!.text).toContain("Overall admin");
    // The audit row exists, and nothing was granted yet.
    expect(auditActions()).toContain("admin_team_invite");
    expect(roleHolders(db)).toEqual([PRAKRIT]);
  });

  it("never shows up as a share link, and cannot be rotated or revealed as one", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    expect(await links.listInviteLinks(client(), PRAKRIT)).toEqual([]);
    const id = String(db.tables.manager_invite_links[0]!.id);
    expect(await links.rotateInviteLinkToken(client(), { actorUserId: PRAKRIT, linkId: id })).toMatchObject({ ok: false, status: 404 });
    expect(await links.revokeInviteLink(client(), { actorUserId: PRAKRIT, linkId: id })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("redeeming grants only for the bound email", () => {
  it("another account with a valid link is refused: no role, no spent use", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    const token = lastToken();
    const refused = await redeem(STRANGER, token);
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(roleHolders(db)).toEqual([PRAKRIT]);
    expect(db.tables.manager_invite_links[0]!.used_count).toBe(0);
    expect(db.tables.admin_team_grants).toHaveLength(0);
  });

  it("an unconfirmed address is refused too", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    (db.auth as { users: Map<string, Record<string, unknown>> }).users.get(AARAV)!.email_confirmed_at = null;
    expect(await redeem(AARAV, lastToken())).toMatchObject({ ok: false, status: 403 });
    expect(roleHolders(db)).toEqual([PRAKRIT]);
  });

  it("the bound email redeems: audit row first, then the Overall admin role and the grant row; a second open changes nothing", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    const token = lastToken();
    const ok = await redeem(AARAV, token);
    expect(ok).toMatchObject({ ok: true, kind: "admin", role: "overall_admin", alreadyRedeemed: false });
    expect(roleHolders(db).sort()).toEqual([PRAKRIT, AARAV].sort());
    expect(auditActions()).toEqual(expect.arrayContaining(["admin_team_invite", "admin_team_grant"]));
    expect(db.tables.audit_log.find((r) => r.action === "admin_team_grant")).toMatchObject({ actor_user_id: PRAKRIT });
    expect(db.tables.admin_team_grants).toEqual([expect.objectContaining({ user_id: AARAV, granted_by: PRAKRIT, role: "overall_admin" })]);
    expect(db.tables.manager_invite_links[0]!.used_count).toBe(1);
    // The link is spent: opening it again changes nothing.
    expect(await redeem(AARAV, token)).toMatchObject({ ok: false, status: 410 });
    expect(db.tables.admin_team_grants).toHaveLength(1);
    expect(roleHolders(db).filter((id) => id === AARAV)).toHaveLength(1);
  });

  it("an exhausted link cannot be used by anyone else", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    const token = lastToken();
    await redeem(AARAV, token);
    expect(await redeem(STRANGER, token)).toMatchObject({ ok: false });
    expect(roleHolders(db)).not.toContain(STRANGER);
  });

  it("an Overall invite is refused at redeem when the inviter stopped being an Overall admin; the use is handed back", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    db.tables.profile_roles = db.tables.profile_roles.filter((r) => !(r.user_id === PRAKRIT && r.role === "admin"));
    const refused = await redeem(AARAV, lastToken());
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(roleHolders(db)).toEqual([]);
    expect(db.tables.manager_invite_links[0]!.used_count).toBe(0);
    expect(db.tables.manager_invite_link_redemptions).toHaveLength(0);
  });

  it("a forged link row with no bound email redeems as nothing", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    db.tables.manager_invite_links[0]!.invitee_email = null;
    expect(await redeem(AARAV, lastToken())).toMatchObject({ ok: false });
    expect(roleHolders(db)).toEqual([PRAKRIT]);
  });
});

describe("who can invite", () => {
  async function seatJordanAsWorkspaceAdmin() {
    await invite(PRAKRIT, { email: "jordan@example.com", role: "admin", workspaceIds: [AMBIKA] });
    expect(await redeem(JORDAN, lastToken())).toMatchObject({ ok: true, kind: "admin", role: "admin", workspaceIds: [AMBIKA] });
    sentEmails.items.length = 0;
  }

  it("an Overall admin seats a workspace role: a PropLane-issued seat on that workspace only, plus the manager portal", async () => {
    await seatJordanAsWorkspaceAdmin();
    const seat = db.tables.account_link_invites.find((l) => l.invitee_user_id === JORDAN)!;
    expect(seat).toMatchObject({ workspace_id: AMBIKA, inviter_user_id: OWNER, team_role: "admin", status: "accepted", is_service_seat: true });
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === JORDAN && l.workspace_id === VINOD)).toBe(false);
    // A workspace role grants no Overall admin.
    expect(roleHolders(db)).not.toContain(JORDAN);
    expect(db.tables.profile_roles).toContainEqual({ user_id: JORDAN, role: "manager" });
    expect(db.tables.admin_team_grants[0]).toMatchObject({ user_id: JORDAN, role: "admin", workspace_ids: [AMBIKA] });
  });

  it("a workspace admin cannot invite an Overall admin: refused before any link or email exists", async () => {
    await seatJordanAsWorkspaceAdmin();
    const refused = await invite(JORDAN, { email: "sam@example.com", role: "overall_admin" });
    expect(refused).toMatchObject({ ok: false, status: 403, error: "Only an Overall admin can invite another Overall admin." });
    expect(db.tables.manager_invite_links).toHaveLength(1);
    expect(sentEmails.items).toHaveLength(0);
  });

  it("a workspace admin cannot invite into a workspace they do not run", async () => {
    await seatJordanAsWorkspaceAdmin();
    expect(await invite(JORDAN, { email: "sam@example.com", role: "viewer", workspaceIds: [VINOD] })).toMatchObject({ ok: false, status: 403 });
    expect(await invite(JORDAN, { email: "sam@example.com", role: "viewer", workspaceIds: [AMBIKA, VINOD] })).toMatchObject({ ok: false, status: 403 });
    expect(sentEmails.items).toHaveLength(0);
  });

  it("a workspace admin cannot grant above their own role, and cannot name another workspace's house", async () => {
    await seatJordanAsWorkspaceAdmin();
    expect(await invite(JORDAN, { email: "sam@example.com", role: "full", workspaceIds: [AMBIKA] })).toMatchObject({ ok: false, status: 403 });
    expect(
      await invite(JORDAN, { email: "sam@example.com", role: "viewer", workspaceIds: [AMBIKA], access: { houseScope: "selected", assignedPropertyIds: ["house-3"] } }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(sentEmails.items).toHaveLength(0);
  });

  it("a workspace admin invites into their own workspace; the redeem seats that role on selected houses only", async () => {
    await seatJordanAsWorkspaceAdmin();
    const sent = await invite(JORDAN, { email: "sam@example.com", role: "property_manager", workspaceIds: [AMBIKA], access: { houseScope: "selected", assignedPropertyIds: ["house-1"] } });
    expect(sent).toMatchObject({ ok: true });
    expect(await redeem(SAM, lastToken())).toMatchObject({ ok: true, role: "property_manager" });
    const seat = db.tables.account_link_invites.find((l) => l.invitee_user_id === SAM)!;
    expect(seat).toMatchObject({ workspace_id: AMBIKA, team_role: "property_manager", house_scope: "selected", assigned_property_ids: ["house-1"], is_service_seat: true });
    expect(roleHolders(db)).not.toContain(SAM);
  });

  it("a workspace admin's invite stops working when they lose their own seat before it is accepted", async () => {
    await seatJordanAsWorkspaceAdmin();
    await invite(JORDAN, { email: "sam@example.com", role: "viewer", workspaceIds: [AMBIKA] });
    const token = lastToken();
    db.tables.account_link_invites = db.tables.account_link_invites.filter((l) => l.invitee_user_id !== JORDAN);
    expect(await redeem(SAM, token)).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === SAM)).toBe(false);
  });

  it("a seat that cannot manage members (a Property manager) cannot invite anyone", async () => {
    await invite(PRAKRIT, { email: "sam@example.com", role: "property_manager", workspaceIds: [AMBIKA] });
    await redeem(SAM, lastToken());
    sentEmails.items.length = 0;
    expect(await invite(SAM, { email: "stranger@example.com", role: "viewer", workspaceIds: [AMBIKA] })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("the last Overall admin", () => {
  it("cannot be removed or demoted", async () => {
    const actor = await actorOf(PRAKRIT);
    expect(await team.removeAdminTeamMember(client(), PRAKRIT, actor, { userId: PRAKRIT })).toMatchObject({ ok: false, status: 409 });
    expect(
      await team.changeAdminTeamMember(client(), PRAKRIT, actor, { userId: PRAKRIT, role: "viewer", workspaceIds: [AMBIKA], access: {} }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(roleHolders(db)).toEqual([PRAKRIT]);
    expect(auditActions()).not.toContain("admin_team_revoke");
  });

  it("with a second Overall admin, one can be removed: audited first, role row gone, grant marked revoked", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    await redeem(AARAV, lastToken());
    const actor = await actorOf(PRAKRIT);
    expect(await team.removeAdminTeamMember(client(), PRAKRIT, actor, { userId: AARAV })).toEqual({ ok: true });
    expect(roleHolders(db)).toEqual([PRAKRIT]);
    expect(auditActions()).toContain("admin_team_revoke");
    expect(db.tables.admin_team_grants[0]!.revoked_by).toBe(PRAKRIT);
    expect(await team.removeAdminTeamMember(client(), PRAKRIT, actor, { userId: PRAKRIT })).toMatchObject({ ok: false, status: 409 });
  });

  it("an Overall admin can be demoted to a workspace role once another exists", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    await redeem(AARAV, lastToken());
    const actor = await actorOf(PRAKRIT);
    const res = await team.changeAdminTeamMember(client(), PRAKRIT, actor, { userId: AARAV, role: "viewer", workspaceIds: [AMBIKA], access: {} });
    expect(res).toEqual({ ok: true });
    expect(roleHolders(db)).toEqual([PRAKRIT]);
    expect(db.tables.account_link_invites.find((l) => l.invitee_user_id === AARAV)).toMatchObject({ workspace_id: AMBIKA, team_role: "viewer", is_service_seat: true });
  });

  it("an admin that comes from the primary-admin email is never removed by this pane", async () => {
    db.tables.profiles.push({ id: STRANGER + "x", email: "founders@axis-seattle-housing.com", role: "manager" });
    const founders = STRANGER + "x";
    const actor = await actorOf(PRAKRIT);
    expect(await team.removeAdminTeamMember(client(), PRAKRIT, actor, { userId: founders })).toMatchObject({ ok: false });
    expect(db.tables.audit_log.some((r) => r.action === "admin_team_revoke")).toBe(false);
  });
});

describe("a workspace admin's reach", () => {
  async function seatBoth() {
    await invite(PRAKRIT, { email: "jordan@example.com", role: "admin", workspaceIds: [AMBIKA] });
    await redeem(JORDAN, lastToken());
    await invite(PRAKRIT, { email: "sam@example.com", role: "viewer", workspaceIds: [AMBIKA, VINOD] });
    await redeem(SAM, lastToken());
    sentEmails.items.length = 0;
  }

  it("changes only seats in workspaces they manage, and never an Overall admin", async () => {
    await seatBoth();
    const jordan = await actorOf(JORDAN);
    expect(jordan.overall).toBe(false);
    expect([...jordan.manageableWorkspaceIds]).toEqual([AMBIKA]);
    // Sam sits on Ambika and Vinod; Jordan's removal touches Ambika only.
    expect(await team.removeAdminTeamMember(client(), JORDAN, jordan, { userId: SAM })).toEqual({ ok: true });
    const left = db.tables.account_link_invites.filter((l) => l.invitee_user_id === SAM && l.status === "accepted");
    expect(left.map((l) => l.workspace_id)).toEqual([VINOD]);
    // An Overall admin is out of reach.
    expect(await team.removeAdminTeamMember(client(), JORDAN, jordan, { userId: PRAKRIT })).toMatchObject({ ok: false, status: 403 });
    expect(await team.changeAdminTeamMember(client(), JORDAN, jordan, { userId: PRAKRIT, role: "viewer", workspaceIds: [AMBIKA], access: {} })).toMatchObject({ ok: false, status: 403 });
    expect(await team.changeAdminTeamMember(client(), JORDAN, jordan, { userId: SAM, role: "overall_admin", workspaceIds: [], access: {} })).toMatchObject({ ok: false, status: 403 });
    expect(roleHolders(db)).toEqual([PRAKRIT]);
  });

  it("the list shows a workspace admin only seats of their own workspaces, and an Overall admin everyone", async () => {
    await seatBoth();
    const asJordan = await team.listAdminTeam(client(), JORDAN, await actorOf(JORDAN));
    if (!asJordan.ok) throw new Error("list failed");
    expect(asJordan.payload.viewer.overall).toBe(false);
    expect(asJordan.payload.workspaces.map((w) => w.id)).toEqual([AMBIKA]);
    // Prakrit sits on Ambika's team too (created it), so Jordan sees him there, as an Overall admin he cannot touch.
    expect(asJordan.payload.members.map((m) => m.userId).sort()).toEqual([PRAKRIT, JORDAN, SAM].sort());
    expect(asJordan.payload.members.find((m) => m.userId === PRAKRIT)).toMatchObject({ role: "overall_admin", canManage: false });
    expect(asJordan.payload.members.find((m) => m.userId === SAM)).toMatchObject({ canManage: true });
    expect(asJordan.payload.members.every((m) => m.seats.every((s) => s.workspaceId === AMBIKA))).toBe(true);
    const asPrakrit = await team.listAdminTeam(client(), PRAKRIT, await actorOf(PRAKRIT));
    if (!asPrakrit.ok) throw new Error("list failed");
    expect(asPrakrit.payload.members.map((m) => m.userId)).toContain(PRAKRIT);
    expect(asPrakrit.payload.workspaces.map((w) => w.id).sort()).toEqual([AMBIKA, VINOD].sort());
  });

  it("a waiting invite is listed as Invited, can be resent (old link off, new one emailed) and turned off", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    const actor = await actorOf(PRAKRIT);
    const listed = await team.listAdminTeam(client(), PRAKRIT, actor);
    if (!listed.ok) throw new Error("list failed");
    const waiting = listed.payload.members.find((m) => m.state === "invited")!;
    expect(waiting).toMatchObject({ email: "aarav@example.com", role: "overall_admin" });
    const oldToken = lastToken();
    expect(await invites.resendAdminInvite(client(), PRAKRIT, actor, waiting.inviteId!)).toMatchObject({ ok: true });
    expect(sentEmails.items).toHaveLength(2);
    expect(await redeem(AARAV, oldToken)).toMatchObject({ ok: false });
    expect(await redeem(AARAV, lastToken())).toMatchObject({ ok: true, role: "overall_admin" });
  });

  it("a workspace admin cannot see or touch an Overall admin's waiting invite", async () => {
    await seatBoth();
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    const jordan = await actorOf(JORDAN);
    const listed = await team.listAdminTeam(client(), JORDAN, jordan);
    if (!listed.ok) throw new Error("list failed");
    expect(listed.payload.members.some((m) => m.state === "invited")).toBe(false);
    const inviteId = String(db.tables.manager_invite_links.find((l) => l.invitee_email === "aarav@example.com")!.id);
    expect(await team.removeAdminTeamMember(client(), JORDAN, jordan, { inviteId })).toMatchObject({ ok: false, status: 403 });
    expect(await invites.resendAdminInvite(client(), JORDAN, jordan, inviteId)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("the routes", () => {
  async function seatJordanAndSam() {
    await invite(PRAKRIT, { email: "jordan@example.com", role: "admin", workspaceIds: [AMBIKA] });
    await redeem(JORDAN, lastToken());
    await invite(PRAKRIT, { email: "sam@example.com", role: "property_manager", workspaceIds: [AMBIKA] });
    await redeem(SAM, lastToken());
    sentEmails.items.length = 0;
  }

  it("a seat holder gets 403 on a PropLane-wide admin route, a stranger and a signed-out caller are refused too", async () => {
    await seatJordanAndSam();
    state.signedIn = null;
    expect(await adminGuard.requireAdminRoute()).toMatchObject({ ok: false, response: expect.objectContaining({ status: 401 }) });
    for (const seatHolder of [JORDAN, SAM, STRANGER]) {
      state.signedIn = seatHolder;
      expect(await adminGuard.requireAdminRoute(), seatHolder).toMatchObject({ ok: false, response: expect.objectContaining({ status: 403 }) });
    }
    state.signedIn = PRAKRIT;
    expect(await adminGuard.requireAdminRoute()).toMatchObject({ ok: true, userId: PRAKRIT });
  });

  it("the team routes admit an Overall admin and a seat that manages members, and refuse the rest", async () => {
    await seatJordanAndSam();
    state.signedIn = null;
    expect((await guard.requireAdminTeamActor()).ok).toBe(false);
    state.signedIn = STRANGER;
    expect(await guard.requireAdminTeamActor()).toMatchObject({ ok: false, response: expect.objectContaining({ status: 403 }) });
    state.signedIn = SAM;
    expect(await guard.requireAdminTeamActor()).toMatchObject({ ok: false, response: expect.objectContaining({ status: 403 }) });
    state.signedIn = JORDAN;
    expect(await guard.requireAdminTeamActor()).toMatchObject({ ok: true, actor: { overall: false } });
    state.signedIn = PRAKRIT;
    expect(await guard.requireAdminTeamActor()).toMatchObject({ ok: true, actor: { overall: true } });
  });

  it("GET lists for the caller's reach; POST invite applies the same rules as the lib", async () => {
    await seatJordanAndSam();
    state.signedIn = JORDAN;
    const list = await teamRoute.GET();
    expect(list.status).toBe(200);
    const body = (await list.json()) as { members: Array<{ userId: string }> };
    expect(body.members.map((m) => m.userId).sort()).toEqual([PRAKRIT, JORDAN, SAM].sort());
    const post = (payload: unknown) =>
      inviteRoute.POST(new Request("https://prop-lane.space/api/admin/team/invite", { method: "POST", body: JSON.stringify(payload), headers: { "Content-Type": "application/json" } }));
    expect((await post({ email: "x@example.com", role: "overall_admin" })).status).toBe(403);
    expect((await post({ email: "x@example.com", role: "viewer", workspaceIds: [VINOD] })).status).toBe(403);
    expect((await post({ email: "x@example.com", role: "viewer", workspaceIds: [AMBIKA] })).status).toBe(201);
    state.signedIn = null;
    expect((await post({ email: "x@example.com", role: "viewer", workspaceIds: [AMBIKA] })).status).toBe(401);
  });

  it("a seat holder's shell shows only their own workspace tiles", async () => {
    await seatJordanAndSam();
    await invite(PRAKRIT, { email: "sam@example.com", role: "viewer", workspaceIds: [VINOD] });
    await redeem(SAM, lastToken());
    const names = async (id: string) => (await mode.loadServiceStaffWorkspaces(client(), id)).map((w) => w.name);
    expect(await names(JORDAN)).toEqual(["1. Ambika"]);
    expect(await names(SAM)).toEqual(["1. Ambika", "2. Vinod"]);
    expect(await names(STRANGER)).toEqual([]);
    // A Property manager seat is staff of the shell now (PropLane issued it), but reaches only its own houses and levels.
    const seat = db.tables.account_link_invites.find((l) => l.invitee_user_id === SAM && l.workspace_id === AMBIKA)!;
    expect(seat.team_role).toBe("property_manager");
  });
});
