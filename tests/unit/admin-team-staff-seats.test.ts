/**
 * Staff seats on PropLane-managed workspaces (captain, Nov 12), over the real service layer and an in-memory database.
 *   * only the PRIMARY admin makes another Overall admin, at invite, at change and again at redeem (audit row first);
 *   * an invited seat is a PropLane-issued membership the alert resolver reads, and revoking it stops the alerts;
 *   * the invitee's own account stays Free (nothing is written to their plan) while the workspace they serve is paid;
 *   * every invite, grant, revoke and owner onboarding is ONE email and at most ONE text, with no duplicates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

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
  userHoldsAdminRoleStrict: async (d: ServiceFakeDb, id: string) => roleHolders(d).includes(id),
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
// The real limiter's semantics (a counter per key, ok until `limit` is spent), but reset for every test so the
// per-actor invite budget of one test never leaks into the next.
const limiter = vi.hoisted(() => ({ counts: new Map<string, number>(), calls: [] as { key: string; limit: number; windowMs: number }[] }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async (key: string, limit: number, windowMs: number) => {
    limiter.calls.push({ key, limit, windowMs });
    const used = (limiter.counts.get(key) ?? 0) + 1;
    limiter.counts.set(key, used);
    return { ok: used <= limit };
  }),
}));
const texts = vi.hoisted(() => ({
  items: [] as Array<{ toPhone: string; text: string; purpose: string; recipientUserId?: string | null }>,
  result: { ok: true } as { ok: true } | { ok: false; reason: string },
}));
vi.mock("@/lib/service/service-manager.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/service/service-manager.server")>()),
  sendTextFromServiceOwner: vi.fn(async (_db: unknown, input: { toPhone: string; text: string; purpose: string; recipientUserId?: string | null }) => {
    texts.items.push({ toPhone: input.toPhone, text: input.text, purpose: input.purpose, recipientUserId: input.recipientUserId });
    return texts.result;
  }),
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

const client = () => db as never;
let AMBIKA = "";
let VINOD = "";

const EMAILS: Record<string, string> = {
  [OWNER]: "owner@example.com",
  // The platform's primary admin: the only account that may make another Overall admin.
  [PRAKRIT]: PRIMARY_ADMIN_EMAIL,
  [AARAV]: "aarav@example.com",
  [JORDAN]: "jordan@example.com",
  [SAM]: "sam@example.com",
  [STRANGER]: "stranger@example.com",
};

function signUp(id: string, opts: { confirmed?: boolean } = {}) {
  db.tables.profiles.push({ id, full_name: `Name ${id.slice(0, 4)}`, email: EMAILS[id], manager_id: `AX-${id.slice(0, 4)}`, role: "manager" });
  (db.auth as { users: Map<string, unknown> }).users.set(id, {
    id,
    email: EMAILS[id],
    created_at: "2026-01-01T00:00:00Z",
    app_metadata: { provider: "email" },
    email_confirmed_at: opts.confirmed === false ? null : "2026-10-27T00:00:00Z",
    user_metadata: { full_name: `Name ${id.slice(0, 4)}` },
  });
}

beforeEach(async () => {
  limiter.counts.clear();
  limiter.calls.length = 0;
  sentEmails.items.length = 0;
  texts.items.length = 0;
  texts.result = { ok: true };
  state.signedIn = PRAKRIT;
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
  const baseRpc = db.rpc.bind(db);
  db.rpc = async (fn, args) => {
    if (fn !== "demote_admin_team_role") return baseRpc(fn, args);
    const actor = String(args.p_actor), target = String(args.p_target);
    if (!roleHolders(db).includes(actor)) return { data: "forbidden", error: null };
    if (!roleHolders(db).includes(target)) {
      const applied = db.tables.audit_log.some((row) => row.action === "admin_team_revoke" && (row.input_summary as { targetUserId?: string; via?: string })?.targetUserId === target && (row.input_summary as { via?: string })?.via === args.p_via && (row.result_summary as { applied?: boolean })?.applied === true);
      return { data: args.p_check_only === true && args.p_via === "remove" && applied ? "already_revoked" : "stale", error: null };
    }
    if (roleHolders(db).length <= 1) return { data: "last_admin", error: null };
    db.tables.profile_roles = db.tables.profile_roles.filter((row) => !(row.user_id === target && row.role === "admin"));
    db.tables.audit_log.push({ action: "admin_team_revoke", actor_user_id: actor, input_summary: { targetUserId: target, via: args.p_via }, result_summary: { applied: true } });
    const plan = args.p_plan as Array<{ workspaceId: string; ownerUserId: string; grant: { teamRole: string } }>;
    for (const seat of db.tables.account_link_invites) if (seat.invitee_user_id === target && seat.is_service_seat === true && !plan.some((p) => p.workspaceId === seat.workspace_id)) seat.status = "cancelled";
    for (const p of plan) {
      let seat = db.tables.account_link_invites.find((row) => row.invitee_user_id === target && row.workspace_id === p.workspaceId && row.is_service_seat === true);
      if (!seat) { seat = { id: `seat-${p.workspaceId}`, invitee_user_id: target, workspace_id: p.workspaceId, inviter_user_id: p.ownerUserId, is_service_seat: true }; db.tables.account_link_invites.push(seat); }
      Object.assign(seat, { status: "accepted", team_role: p.grant.teamRole });
    }
    return { data: "revoked", error: null };
  };
  const users = new Map<string, unknown>();
  db.auth = {
    users,
    admin: {
      getUserById: async (id: string) => ({ data: { user: users.get(id) ?? null }, error: null }),
      listUsers: async () => ({ data: { users: [...users.values()] }, error: null }),
      createUser: async (input: { email: string; email_confirm?: boolean; user_metadata?: object; app_metadata?: object }) => {
        const id = `99999999-9999-4999-8999-${String(users.size).padStart(12, "0")}`;
        users.set(id, {
          id,
          email: input.email,
          created_at: new Date().toISOString(),
          app_metadata: { provider: "email", ...(input.app_metadata ?? {}) },
          email_confirmed_at: input.email_confirm ? new Date().toISOString() : null,
          user_metadata: input.user_metadata ?? {},
        });
        return { data: { user: users.get(id) }, error: null };
      },
    },
  };
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

async function invite(by: string, input: { email: string; role: string; workspaceIds?: string[]; access?: Record<string, unknown>; phone?: string }) {
  return invites.inviteAdminTeamMember(client(), by, await actorOf(by), {
    email: input.email,
    phone: input.phone,
    role: input.role,
    workspaceIds: input.workspaceIds ?? [],
    access: (input.access ?? {}) as never,
  });
}

process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const alerts = await import("@/lib/service/service-alert-targets.server");
const readOnly = await import("@/lib/auth/managed-read-only.server");
const ownerSeats = await import("@/lib/property-owner/service-owner-seat.server");
const accessMod = await import("@/lib/manager-access");
const { PRIMARY_ADMIN_EMAIL: PRIMARY_EMAIL, PRIMARY_ADMIN_PHONE_E164 } = await import("@/lib/auth/primary-admin");
const notices = await import("@/lib/admin-team/admin-team-notices");

const redeem = (userId: string, token: string) => links.redeemInviteLink(client(), { token, redeemerUserId: userId });

const authUser = (id: string) => (db.auth as { users: Map<string, Record<string, unknown>> }).users.get(id)!;
const profile = (id: string) => db.tables.profiles.find((p) => p.id === id)!;
const give = (id: string, phone: string, verified = true) => Object.assign(profile(id), { phone, phone_verified_at: verified ? "2026-11-01T00:00:00Z" : null, sms_forward_inbound: true });
const seatRows = (userId: string) => db.tables.account_link_invites.filter((l) => l.invitee_user_id === userId && l.is_service_seat === true);
const targetsFor = async (workspaceId: string) => alerts.resolveServiceAlertTargets(client(), { workspaceId, module: "inbox" });
const emailsTo = (to: string) => sentEmails.items.filter((m) => m.to.includes(to));
const inviteUrl = (text: string) => /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/.exec(text)![0];

describe("only the primary admin makes Overall admins", () => {
  it("the primary admin is an Overall admin signed in with the confirmed primary-admin email, and nothing else", async () => {
    expect(await team.userIsPrimaryAdmin(client(), PRAKRIT)).toBe(true);
    expect(PRIMARY_ADMIN_PHONE_E164).toBe("+15103098345");
    // Another Overall admin: not primary.
    db.tables.profile_roles.push({ user_id: AARAV, role: "admin" });
    expect(await team.userIsPrimaryAdmin(client(), AARAV)).toBe(false);
    // The primary email without the role: not primary.
    authUser(SAM).email = PRIMARY_EMAIL;
    expect(await team.userIsPrimaryAdmin(client(), SAM)).toBe(false);
    // The role and a profile row that CLAIMS the primary email (the column has no unique constraint): the Auth email decides.
    db.tables.profile_roles.push({ user_id: SAM, role: "admin" });
    authUser(SAM).email = EMAILS[SAM];
    profile(SAM).email = PRIMARY_EMAIL;
    expect(await team.userIsPrimaryAdmin(client(), SAM)).toBe(false);
    // An unconfirmed primary email, and an unreadable Auth user, fail closed.
    authUser(PRAKRIT).email_confirmed_at = null;
    expect(await team.userIsPrimaryAdmin(client(), PRAKRIT)).toBe(false);
    authUser(PRAKRIT).email_confirmed_at = "2026-10-27T00:00:00Z";
    const admin = (db.auth as { admin: { getUserById: unknown } }).admin;
    const original = admin.getUserById;
    admin.getUserById = async () => ({ data: null, error: { message: "boom" } });
    expect(await team.userIsPrimaryAdmin(client(), PRAKRIT)).toBe(false);
    admin.getUserById = original;
    expect(await team.userIsPrimaryAdmin(client(), PRAKRIT)).toBe(true);
  });

  it("an Overall admin who is not primary is refused: no link, no email, no text, no audit row", async () => {
    db.tables.profile_roles.push({ user_id: AARAV, role: "admin" });
    const refused = await invite(AARAV, { email: "sam@example.com", role: "overall_admin", phone: "+12065550101" });
    expect(refused).toMatchObject({ ok: false, status: 403, error: "Only the primary admin can make another Overall admin." });
    expect(db.tables.manager_invite_links).toHaveLength(0);
    expect(sentEmails.items).toHaveLength(0);
    expect(texts.items).toHaveLength(0);
    expect(db.tables.audit_log.filter((r) => String(r.action).startsWith("admin_team_"))).toHaveLength(0);
    // The same person still seats a WORKSPACE role: that rule did not tighten.
    expect(await invite(AARAV, { email: "sam@example.com", role: "viewer", workspaceIds: [AMBIKA] })).toMatchObject({ ok: true });
  });

  it("the primary admin invites; at redeem the inviter is re-checked, and an inviter who stopped being primary grants nothing", async () => {
    expect(await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" })).toMatchObject({ ok: true });
    const token = lastToken();
    const grantAuditsBefore = db.tables.audit_log.filter((r) => r.action === "admin_team_grant").length;
    // Between invite and redeem the inviter's sign-in email changed: no longer the primary admin.
    authUser(PRAKRIT).email = "someone-else@example.com";
    expect(await redeem(AARAV, token)).toMatchObject({ ok: false, status: 403 });
    expect(roleHolders(db)).not.toContain(AARAV);
    expect(db.tables.audit_log.filter((r) => r.action === "admin_team_grant")).toHaveLength(grantAuditsBefore);
    expect(db.tables.admin_team_grants).toHaveLength(0);
    // The spent use was handed back: with the primary admin primary again, the same link works.
    authUser(PRAKRIT).email = PRIMARY_EMAIL;
    expect(await redeem(AARAV, token)).toMatchObject({ ok: true, kind: "admin", role: "overall_admin" });
    expect(roleHolders(db)).toContain(AARAV);
    expect(db.tables.audit_log.find((r) => r.action === "admin_team_grant")).toMatchObject({ actor_user_id: PRAKRIT });
  });

  it("an Overall invite whose inviter lost the Overall role is refused at redeem too", async () => {
    await invite(PRAKRIT, { email: "aarav@example.com", role: "overall_admin" });
    db.tables.profile_roles = db.tables.profile_roles.filter((r) => !(r.user_id === PRAKRIT && r.role === "admin"));
    expect(await redeem(AARAV, lastToken())).toMatchObject({ ok: false, status: 403 });
    expect(roleHolders(db)).not.toContain(AARAV);
  });

  it("promoting through Change is the primary admin's alone", async () => {
    db.tables.profile_roles.push({ user_id: AARAV, role: "admin" });
    await invite(AARAV, { email: "sam@example.com", role: "viewer", workspaceIds: [AMBIKA] });
    await redeem(SAM, lastToken());
    expect(await team.changeAdminTeamMember(client(), AARAV, await actorOf(AARAV), { userId: SAM, role: "overall_admin", workspaceIds: [], access: {} })).toMatchObject({ ok: false, status: 403 });
    expect(roleHolders(db)).not.toContain(SAM);
    expect(await team.changeAdminTeamMember(client(), PRAKRIT, await actorOf(PRAKRIT), { userId: SAM, role: "overall_admin", workspaceIds: [], access: {} })).toEqual({ ok: true });
    expect(roleHolders(db)).toContain(SAM);
  });

  it("the last Overall admin still cannot be removed", async () => {
    expect(await team.removeAdminTeamMember(client(), PRAKRIT, await actorOf(PRAKRIT), { userId: PRAKRIT })).toMatchObject({ ok: false });
    expect(roleHolders(db)).toContain(PRAKRIT);
  });

  it("the Admin team list says who the viewer is, so the sheet offers Overall admin only to the primary admin", async () => {
    db.tables.profile_roles.push({ user_id: AARAV, role: "admin" });
    const asPrimary = await team.listAdminTeam(client(), PRAKRIT, await actorOf(PRAKRIT));
    const asOther = await team.listAdminTeam(client(), AARAV, await actorOf(AARAV));
    expect(asPrimary.ok && asPrimary.payload.viewer).toMatchObject({ overall: true, primary: true });
    expect(asOther.ok && asOther.payload.viewer).toMatchObject({ overall: true, primary: false });
  });
});

describe("a staff seat: the alerts follow the seat, and stop when it is revoked", () => {
  async function seat(workspaceIds: string[], role = "property_manager", access: Record<string, unknown> = {}) {
    expect(await invite(PRAKRIT, { email: "jordan@example.com", role, workspaceIds, access })).toMatchObject({ ok: true });
    expect(await redeem(JORDAN, lastToken())).toMatchObject({ ok: true, kind: "admin", workspaceIds });
  }

  it("is read by the alert resolver for exactly the workspaces it was granted: Ambika's only, not Vinod's", async () => {
    give(JORDAN, "+12065550142");
    await seat([AMBIKA]);
    expect(seatRows(JORDAN)).toEqual([expect.objectContaining({ inviter_user_id: OWNER, workspace_id: AMBIKA, status: "accepted", is_service_seat: true })]);
    const ambika = await targetsFor(AMBIKA);
    expect(ambika?.seatPhones).toEqual(["+12065550142"]);
    expect(ambika?.emails.filter((e) => e.userId === JORDAN)).toHaveLength(1);
    const vinod = await targetsFor(VINOD);
    expect(vinod?.seatPhones).toEqual([]);
    expect(vinod?.emails.filter((e) => e.userId === JORDAN)).toHaveLength(0);
  });

  it("covers every workspace a seat names (Vinod's and Ambika's)", async () => {
    give(JORDAN, "+12065550142");
    await seat([AMBIKA, VINOD]);
    expect((await targetsFor(AMBIKA))?.seatPhones).toEqual(["+12065550142"]);
    expect((await targetsFor(VINOD))?.seatPhones).toEqual(["+12065550142"]);
  });

  it("selected houses are the alert scope: an event on another house of the workspace does not reach the seat", async () => {
    give(JORDAN, "+12065550142");
    await seat([AMBIKA], "property_manager", { houseScope: "selected", assignedPropertyIds: ["house-1"] });
    const on = await alerts.resolveServiceAlertTargets(client(), { workspaceId: AMBIKA, module: "inbox", propertyId: "house-1" });
    const off = await alerts.resolveServiceAlertTargets(client(), { workspaceId: AMBIKA, module: "inbox", propertyId: "house-2" });
    expect(on?.seatPhones).toEqual(["+12065550142"]);
    expect(off?.seatPhones).toEqual([]);
  });

  it("a phone that is not verified is never texted, but the seat still gets email", async () => {
    give(JORDAN, "+12065550142", false);
    await seat([AMBIKA]);
    const t = await targetsFor(AMBIKA);
    expect(t?.seatPhones).toEqual([]);
    expect(t?.emails.some((e) => e.userId === JORDAN)).toBe(true);
  });

  it("revoking the seat removes the alert targets", async () => {
    give(JORDAN, "+12065550142");
    await seat([AMBIKA, VINOD]);
    expect(await team.removeAdminTeamMember(client(), PRAKRIT, await actorOf(PRAKRIT), { userId: JORDAN })).toEqual({ ok: true });
    expect(seatRows(JORDAN).every((row) => row.status === "cancelled")).toBe(true);
    for (const ws of [AMBIKA, VINOD]) {
      const t = await targetsFor(ws);
      expect(t?.seatPhones).toEqual([]);
      expect(t?.emails.some((e) => e.userId === JORDAN)).toBe(false);
    }
  });

  it("removing one workspace through the Service team verb stops only that workspace's alerts", async () => {
    give(JORDAN, "+12065550142");
    await seat([AMBIKA, VINOD]);
    const ambikaSeat = seatRows(JORDAN).find((r) => r.workspace_id === AMBIKA)!;
    expect(await svc.removeServiceTeamMember(client(), PRAKRIT, { id: AMBIKA, linkId: ambikaSeat.id }, { overall: true })).toEqual({ ok: true });
    expect((await targetsFor(AMBIKA))?.seatPhones).toEqual([]);
    expect((await targetsFor(VINOD))?.seatPhones).toEqual(["+12065550142"]);
  });
});

describe("a staff seat never changes the invitee's own plan; the workspace they serve is the paid one", () => {
  it("writes no plan or purchase for the invitee, who keeps a Property portal (manager role) on their own Free account", async () => {
    db.tables.manager_purchases = [];
    await invite(PRAKRIT, { email: "jordan@example.com", role: "admin", workspaceIds: [AMBIKA] });
    await redeem(JORDAN, lastToken());
    expect(db.tables.manager_purchases).toEqual([]);
    expect(db.tables.profile_roles).toContainEqual({ user_id: JORDAN, role: "manager" });
    expect(db.tables.profile_roles).not.toContainEqual({ user_id: JORDAN, role: "admin" });
    // The account's OWN plan resolves to Free (no row = Free), through the one resolver every quota reads.
    expect(accessMod.resolveEffectiveManagerSkuTier({ tier: null })).toBe("free");
    // The workspace they serve is the paid side, exactly like a free co-manager of a paid owner: with no houses of their own
    // they inherit the best linked owner tier; with their own houses their own tier stays Free.
    expect(accessMod.pickManagerPortalNavSubscriptionTier("free", false, ["paid"])).toBe("paid");
    expect(accessMod.pickManagerPortalNavSubscriptionTier("free", true, ["paid"])).toBe("free");
  });

  it("opens the service shell for the seat's workspaces only; their own workspace stays an ordinary Property portal", async () => {
    await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA] });
    await redeem(JORDAN, lastToken());
    const { decideServiceMode } = await import("@/lib/service/service-mode");
    const staff = await mode.loadServiceStaffIds(client(), JORDAN);
    expect(staff.ids.has(AMBIKA)).toBe(true);
    expect(staff.ids.has(VINOD)).toBe(false);
    const ws = (id: string, isService: boolean) => ({ id, isService, propertyIds: [] }) as never;
    expect(decideServiceMode([ws(AMBIKA, true)], staff.ids, AMBIKA).mode).toBe("service");
    expect(decideServiceMode([ws(VINOD, true)], staff.ids, VINOD).mode).toBe("property");
    expect(decideServiceMode([ws("own", false)], staff.ids, "own").mode).toBe("property");
  });
});

describe("one email and at most one text, every time", () => {
  it("an invite with a mobile is one email and one text that carry the same link; the number is not stored", async () => {
    const sent = await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA], phone: "(206) 555-0142" });
    expect(sent).toMatchObject({ ok: true, texted: true });
    expect(sentEmails.items).toHaveLength(1);
    expect(texts.items).toHaveLength(1);
    expect(texts.items[0]).toMatchObject({ toPhone: "+12065550142" });
    expect(texts.items[0]!.text).toContain(inviteUrl(sentEmails.items[0]!.text));
    expect(JSON.stringify(db.tables.manager_invite_links)).not.toContain("5550142");
  });

  it("no mobile, or one that is not a phone number: email only", async () => {
    await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA] });
    await invite(PRAKRIT, { email: "sam@example.com", role: "viewer", workspaceIds: [AMBIKA], phone: "not a phone" });
    expect(sentEmails.items).toHaveLength(2);
    expect(texts.items).toHaveLength(0);
  });

  it("a text the consent rules refuse never fails the invite: the email is the one channel", async () => {
    texts.result = { ok: false, reason: "scoped_consent_missing" };
    const sent = await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA], phone: "+12065550142" });
    expect(sent).toMatchObject({ ok: true, texted: false });
    expect(sentEmails.items).toHaveLength(1);
    expect(texts.items).toHaveLength(1);
  });

  it("a resend sends one fresh email and no second text", async () => {
    await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA], phone: "+12065550142" });
    const inviteId = String(db.tables.manager_invite_links[0]!.id);
    texts.items.length = 0;
    sentEmails.items.length = 0;
    expect(await invites.resendAdminInvite(client(), PRAKRIT, await actorOf(PRAKRIT), inviteId)).toMatchObject({ ok: true });
    expect(sentEmails.items).toHaveLength(1);
    expect(texts.items).toHaveLength(0);
  });

  it("revoking a live seat is one email (all its workspaces in it) and one text to the verified phone, nothing to an unverified one", async () => {
    give(JORDAN, "+12065550142");
    await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA, VINOD] });
    await redeem(JORDAN, lastToken());
    sentEmails.items.length = 0;
    texts.items.length = 0;
    await team.removeAdminTeamMember(client(), PRAKRIT, await actorOf(PRAKRIT), { userId: JORDAN });
    expect(sentEmails.items).toHaveLength(1);
    expect(sentEmails.items[0]).toMatchObject({ to: ["jordan@example.com"], subject: "Your access to 1. Ambika and 2. Vinod was removed" });
    expect(texts.items).toHaveLength(1);
    expect(texts.items[0]).toMatchObject({ toPhone: "+12065550142", recipientUserId: JORDAN });

    // A second revoke, of a person whose phone is unverified: the email, no text.
    give(SAM, "+12065550155", false);
    await invite(PRAKRIT, { email: "sam@example.com", role: "viewer", workspaceIds: [AMBIKA] });
    await redeem(SAM, lastToken());
    sentEmails.items.length = 0;
    texts.items.length = 0;
    await team.removeAdminTeamMember(client(), PRAKRIT, await actorOf(PRAKRIT), { userId: SAM });
    expect(sentEmails.items).toHaveLength(1);
    expect(texts.items).toHaveLength(0);
  });

  it("turning off a pending invite tells no one", async () => {
    await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA] });
    sentEmails.items.length = 0;
    expect(await team.removeAdminTeamMember(client(), PRAKRIT, await actorOf(PRAKRIT), { inviteId: String(db.tables.manager_invite_links[0]!.id) })).toEqual({ ok: true });
    expect(sentEmails.items).toHaveLength(0);
    expect(texts.items).toHaveLength(0);
  });

  it("the Service team remove verb sends the same one revoke notice", async () => {
    give(JORDAN, "+12065550142");
    await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA] });
    await redeem(JORDAN, lastToken());
    sentEmails.items.length = 0;
    texts.items.length = 0;
    await svc.removeServiceTeamMember(client(), PRAKRIT, { id: AMBIKA, linkId: seatRows(JORDAN)[0]!.id }, { overall: true });
    expect(emailsTo("jordan@example.com")).toHaveLength(1);
    expect(texts.items).toHaveLength(1);
  });

  it("a change that adds a workspace sends ONE grant notice naming only the new one; a plain role edit sends none", async () => {
    give(JORDAN, "+12065550142");
    await invite(PRAKRIT, { email: "jordan@example.com", role: "viewer", workspaceIds: [AMBIKA] });
    await redeem(JORDAN, lastToken());
    sentEmails.items.length = 0;
    texts.items.length = 0;
    expect(await team.changeAdminTeamMember(client(), PRAKRIT, await actorOf(PRAKRIT), { userId: JORDAN, role: "viewer", workspaceIds: [AMBIKA, VINOD], access: {} })).toEqual({ ok: true });
    expect(sentEmails.items).toHaveLength(1);
    expect(sentEmails.items[0]).toMatchObject({ subject: "You now help manage 2. Vinod" });
    expect(texts.items).toHaveLength(1);
    sentEmails.items.length = 0;
    texts.items.length = 0;
    expect(await team.changeAdminTeamMember(client(), PRAKRIT, await actorOf(PRAKRIT), { userId: JORDAN, role: "property_manager", workspaceIds: [AMBIKA, VINOD], access: {} })).toEqual({ ok: true });
    expect(sentEmails.items).toHaveLength(0);
    expect(texts.items).toHaveLength(0);
  });
});

describe("the owner of a managed workspace", () => {
  // The in-memory database has no workspace-houses triggers, so the operator's seat carries no per-house keys; an owner invite
  // on a workspace with houses is covered by service-team-invite.test.ts. Here the workspace is empty.
  beforeEach(() => {
    db.tables.manager_property_records.length = 0;
  });
  const ownerInvite = (email: string, extra: Record<string, unknown> = {}) =>
    svc.inviteServiceClient(client(), PRAKRIT, { id: AMBIKA, email, ownerOfRecord: true, ...extra } as never);

  it("onboarding a new owner is one email with the owner copy and one text with the same link when a mobile is given", async () => {
    expect(await ownerInvite("ambika@example.com", { inviteeName: "Ambika Mago", phone: "(510) 579-1976" })).toMatchObject({ ok: true, delivery: "link" });
    expect(sentEmails.items).toHaveLength(1);
    expect(sentEmails.items[0]).toMatchObject({ to: ["ambika@example.com"], subject: "PropLane manages 1. Ambika for you" });
    expect(sentEmails.items[0]!.text).toContain("Hi Ambika,");
    expect(texts.items).toHaveLength(1);
    expect(texts.items[0]).toMatchObject({ toPhone: "+15105791976" });
    expect(texts.items[0]!.text).toBe(`PropLane: 1. Ambika is ready. Create your account to see your homes: ${inviteUrl(sentEmails.items[0]!.text)}`);
  });

  it("without a mobile it is the email alone", async () => {
    await ownerInvite("ambika@example.com");
    expect(sentEmails.items).toHaveLength(1);
    expect(texts.items).toHaveLength(0);
  });

  it("the invite link is one use, bound to the owner's email, and a Property owner seat (view only)", async () => {
    await ownerInvite("ambika@example.com");
    const link = db.tables.manager_invite_links.find((l) => String(l.label ?? "").startsWith("Service invite"))!;
    expect(link).toMatchObject({ kind: "manager", team_role: "property_owner", max_uses: 1, workspace_id: AMBIKA });
  });

  it("an owner who already has an account is invited as a pending owner-of-record seat; once accepted they are view-only and never staff", async () => {
    const OWNER_USER = "77777777-7777-4777-8777-777777777777";
    db.tables.profiles.push({ id: OWNER_USER, email: "ambika@example.com", full_name: "Ambika Mago", manager_id: "AX-7777", role: "manager" });
    db.tables.profile_roles.push({ user_id: OWNER_USER, role: "manager" });
    expect(await ownerInvite("ambika@example.com")).toMatchObject({ ok: true, delivery: "account" });
    const pending = db.tables.account_link_invites.find((l) => l.invitee_user_id === OWNER_USER)!;
    expect(pending).toMatchObject({ team_role: "property_owner", is_owner_of_record: true, status: "pending", is_service_seat: false });
    pending.status = "accepted";
    expect(await readOnly.managedReadOnlyWorkspaceIds(client(), OWNER_USER)).toContain(AMBIKA);
    expect((await ownerSeats.loadServiceOwnerSeats(client(), OWNER_USER)).map((s) => s.workspace_id)).toEqual([AMBIKA]);
    expect((await mode.loadServiceStaffIds(client(), OWNER_USER)).ids.has(AMBIKA)).toBe(false);
    // The client owner is not a staff alert target of her own workspace.
    expect((await targetsFor(AMBIKA))?.emails.some((e) => e.userId === OWNER_USER)).toBe(false);
  });
});

describe("the notice copy", () => {
  it("is plain: no long dashes, one short line per text, every list reads naturally", () => {
    const url = "https://proplane.ai/invite/abc";
    const all = [
      notices.buildAdminInviteText({ inviterName: "Prakrit", roleLabel: "Workspace admin", workspaceNames: ["1. Ambika", "2. Vinod"], acceptUrl: url }),
      notices.buildSeatGrantedText({ workspaceNames: ["2. Vinod"], openUrl: url }),
      notices.buildSeatRevokedText({ workspaceNames: ["1. Ambika"] }),
      notices.buildSeatGrantedBody({ inviterName: "Prakrit", roleLabel: "Viewer", workspaceNames: ["2. Vinod"], openUrl: url }),
      notices.buildSeatRevokedBody({ workspaceNames: ["1. Ambika", "2. Vinod"] }),
      notices.seatGrantedSubject(["1. Ambika"]),
      notices.seatRevokedSubject(["1. Ambika", "2. Vinod", "3. Sam"]),
    ];
    for (const copy of all) expect(copy).not.toMatch(/[–—]/);
    expect(notices.buildAdminInviteText({ inviterName: "Prakrit", roleLabel: "Workspace admin", workspaceNames: ["1. Ambika"], acceptUrl: url }).length).toBeLessThanOrEqual(160);
    expect(notices.seatRevokedSubject(["1. Ambika", "2. Vinod", "3. Sam"])).toBe("Your access to 1. Ambika, 2. Vinod and 3. Sam was removed");
  });
});
