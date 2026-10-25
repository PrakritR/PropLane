/**
 * Who the PropLane line serves (the 206 line), one rule set, against fixtures (an in-memory Supabase):
 *
 *   1 platform admin           verified + unique profile phone (or the service-manager setting): every service workspace
 *   2 seat on a service ws     delegated, that seat's houses and modules; a Viewer seat has no write tool
 *   3-5 resident, prospect, vendor of managed homes: unchanged
 *   6 unknown number           clear first text skips the question, unclear gets one; the answers route
 *   9 self-serve manager/team/resident/vendor: not served; paid number or pricing line
 *
 * (Rules 7 and 8, a self-serve home asked about by street / name / title, are in one-number-house-redirect.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const state = vi.hoisted(() => ({
  /** manager id -> paid? (the entitlement answer) */
  entitled: {} as Record<string, "paid" | "trial" | "lapsed" | "unreadable">,
  /** manager id -> their own sendable work number */
  numbers: {} as Record<string, string | null>,
  sent: [] as Array<{ managerUserId: string; to: string; text: string; dedupeKey?: string | null; fromNumber?: string | null; purpose?: string }>,
  suppressed: false,
}));

vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: async (_db: unknown, id: string) => {
    const kind = state.entitled[id] ?? "lapsed";
    if (kind === "unreadable") return { ok: false };
    return kind === "paid" ? { ok: true, entitled: true, via: "plan", tier: "pro" } : { ok: true, entitled: false, tier: kind === "trial" ? "pro" : "free" };
  },
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sms/manager-number-provisioning.server")>();
  return { ...actual, resolveActiveManagerSendNumber: async (_db: unknown, id: string) => state.numbers[id] ?? null };
});
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: async (args: { managerUserId: string; to: string; text: string; dedupeKey?: string | null; fromNumber?: string | null; purpose?: string }) => {
    state.sent.push(args);
    (db.tables.sms_outbox ??= []).push({ id: `ob-${state.sent.length}`, manager_user_id: args.managerUserId, recipient_phone: args.to, dedupe_key: args.dedupeKey ?? null });
    return { ok: true };
  },
}));
vi.mock("@/lib/sms-consent", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sms-consent")>();
  return {
    ...actual,
    readSmsSuppressionState: async () => ({ ok: true, optedOut: state.suppressed }),
    readScopedSmsConsentState: async () => ({ ok: true, state: "none" }),
    recordScopedSmsConsent: async () => ({ ok: true }),
  };
});
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));

import { buildManagerSmsRegistry } from "@/lib/tools";
import {
  buildServiceManagerAgentContext,
  listServiceWorkspacesFor,
  pickServiceWorkspace,
  recognizeServiceManagerInbound,
} from "@/lib/sms/service-manager-inbound.server";
import { handleLineMemberText } from "@/lib/one-number/line-member-status.server";
import { answerPropLaneLineText } from "@/lib/one-number/line-inbound.server";
import { SELF_SERVE_PRICING_REPLY, buildSelfServeLineReply } from "@/lib/one-number/self-serve-line.server";
import { handleRoleQuestionInbound, ROLE_ANSWER_WINDOW_MS } from "@/lib/sms/role-question-line-inbound.server";
import { resolveHouseRedirect } from "@/lib/one-number/house-redirect.server";
import type { MockProperty } from "@/data/types";
import { MANAGE_OWN_REPLY, PROPLANE_ROLE_QUESTION, RESIDENT_NOT_FOUND_REPLY, VENDOR_TRADE_QUESTION } from "@/lib/sms/propline-first-text";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const LINE = "+12066781909";
const SO = "so";
const ADMIN = "admin-1";
const CLIENT_A = "client-a";
const CLIENT_V = "client-v";
const SELF = "self-mgr";
const STAFF_FULL = "staff-full";
const STAFF_VIEW = "staff-view";
const STAFF_SELF = "staff-self";
const RES_A = "res-a";
const RES_SELF = "res-self";
const VENDOR_SELF = "vendor-self";
const WS_A = "ws-ambika";
const WS_V = "ws-vinod";
const WS_SELF = "ws-self";
const WS_SO = "ws-so";

const PHONES = {
  so: "+15103098345",
  admin: "+12065550101",
  staffFull: "+12065550102",
  staffView: "+12065550103",
  self: "+12065550104",
  staffSelf: "+12065550105",
  resA: "+12065550106",
  resSelf: "+12065550107",
  vendorSelf: "+12065550108",
  stranger: "+12065550199",
};

let db: FakeDb;

const profile = (id: string, phone: string | null, over: Row = {}): Row => ({ id, email: `${id}@x.com`, role: "manager", phone, phone_verified_at: phone ? VERIFIED : null, ...over });
const seat = (invitee: string, inviter: string, workspace: string, role: string, assigned: string[]): Row => ({
  id: `inv-${invitee}-${workspace}`,
  invitee_user_id: invitee,
  inviter_user_id: inviter,
  workspace_id: workspace,
  status: "accepted",
  team_role: role,
  house_scope: "all",
  assigned_property_ids: assigned,
  co_manager_permissions: {},
  property_co_manager_permissions: null,
});

function world(extra: Record<string, Row[]> = {}): FakeDb {
  const base: Record<string, Row[]> = {
    sms_runtime_config: [{ singleton: true, line_mode: "per_workspace", shared_number_e164: null, shared_pilot_workspace_ids: [] }],
    platform_service_settings: [{ singleton: true, owner_user_id: SO, manager_phone_e164: PHONES.so, manager_phone_verified_at: VERIFIED }],
    manager_sms_numbers: [{ id: "n1", manager_user_id: SO, phone_number: LINE, provision_state: "active", released_at: null }],
    portal_workspaces: [
      { id: WS_A, name: "1. Ambika", owner_user_id: CLIENT_A, is_default: true, is_service: true },
      { id: WS_V, name: "2. Vinod", owner_user_id: CLIENT_V, is_default: true, is_service: true },
      { id: WS_SELF, name: "Elm Rentals", owner_user_id: SELF, is_default: true, is_service: false },
      { id: WS_SO, name: "PropLane", owner_user_id: SO, is_default: true, is_service: false },
    ],
    manager_property_records: [
      { id: "prop-a1", manager_user_id: CLIENT_A, workspace_id: WS_A, row_data: { buildingName: "5259 Brooklyn" } },
      { id: "prop-a2", manager_user_id: CLIENT_A, workspace_id: WS_A, row_data: { buildingName: "4709A 8th Ave" } },
      { id: "prop-v1", manager_user_id: CLIENT_V, workspace_id: WS_V, row_data: { buildingName: "Vinod House" } },
      { id: "prop-s1", manager_user_id: SELF, workspace_id: WS_SELF, row_data: { buildingName: "12 Elm" } },
    ],
    profiles: [
      profile(SO, PHONES.so),
      profile(ADMIN, PHONES.admin, { role: "admin" }),
      profile(STAFF_FULL, PHONES.staffFull),
      profile(STAFF_VIEW, PHONES.staffView),
      profile(SELF, PHONES.self),
      profile(STAFF_SELF, PHONES.staffSelf),
      profile(RES_A, PHONES.resA, { role: "resident" }),
      profile(RES_SELF, PHONES.resSelf, { role: "resident" }),
      profile(VENDOR_SELF, PHONES.vendorSelf, { role: "vendor" }),
      profile(CLIENT_A, null),
      profile(CLIENT_V, null),
    ],
    profile_roles: [
      { user_id: SO, role: "admin" },
      { user_id: ADMIN, role: "admin" },
      { user_id: ADMIN, role: "manager" },
      { user_id: STAFF_FULL, role: "manager" },
      { user_id: STAFF_VIEW, role: "manager" },
      { user_id: SELF, role: "manager" },
      { user_id: STAFF_SELF, role: "manager" },
    ],
    account_link_invites: [
      seat(STAFF_FULL, CLIENT_A, WS_A, "property_manager", ["prop-a1"]),
      seat(STAFF_VIEW, CLIENT_A, WS_A, "viewer", ["prop-a1", "prop-a2"]),
      seat(STAFF_SELF, SELF, WS_SELF, "property_manager", ["prop-s1"]),
    ],
    manager_application_records: [
      { id: "app-a", manager_user_id: CLIENT_A, resident_email: `${RES_A}@x.com`, property_id: "prop-a1", row_data: { bucket: "approved" } },
      { id: "app-s", manager_user_id: SELF, resident_email: `${RES_SELF}@x.com`, property_id: "prop-s1", row_data: { bucket: "approved" } },
    ],
    agent_sessions: [],
    portal_work_order_records: [],
    sms_outbox: [],
    sms_onboarding_state: [],
    ...extra,
  };
  return createFakeDb(base);
}

beforeEach(() => {
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG-test");
  db = world();
  state.entitled = {};
  state.numbers = {};
  state.sent = [];
  state.suppressed = false;
});

const recognize = (fromPhone: string, over: Record<string, string> = {}) =>
  recognizeServiceManagerInbound(db as never, { managerId: SO, fromPhone, toPhone: LINE, ...over });

// ---------------------------------------------------------------------------------------------------------------------
describe("rule 1: a platform admin is the manager of every service workspace", () => {
  it("an admin (profile_roles) whose profile phone is verified and unique: the full agent across every service workspace", async () => {
    const found = await recognize(PHONES.admin);
    expect(found).toMatchObject({ serviceManager: true, basis: "admin", actorUserId: ADMIN, workNumberOwnerId: SO, workNumber: LINE });
    const workspaces = await listServiceWorkspacesFor(db as never, found!);
    expect(workspaces!.map((w) => w.id).sort()).toEqual([WS_A, WS_V].sort());
    // Not a workspace PropLane does not manage.
    expect(workspaces!.some((w) => w.id === WS_SELF || w.id === WS_SO)).toBe(false);
  });

  it("the full agent: the owner-mode context over the picked workspace, the admin as actor, writes available", async () => {
    const found = (await recognize(PHONES.admin))!;
    const ambika = (await listServiceWorkspacesFor(db as never, found))!.find((w) => w.id === WS_A)!;
    const built = await buildServiceManagerAgentContext(db as never, { serviceOwnerId: found.actorUserId, workspace: ambika });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.ctx.userId).toBe(ADMIN);
    expect(built.ctx.landlordId).toBe(CLIENT_A);
    expect(built.ctx.managerSmsAccess).toMatchObject({ mode: "owner", workspacePropertyIds: ["prop-a1", "prop-a2"] });
    expect(built.ctx.managerSmsAccess?.readOnly).toBeUndefined();
    const writes = [...buildManagerSmsRegistry(built.ctx.managerSmsAccess).values()].filter((tool) => tool.kind === "write");
    expect(writes.length).toBeGreaterThan(0);
  });

  it("asks which workspace when the text does not say, and remembers the pick", async () => {
    const found = (await recognize(PHONES.admin))!;
    const workspaces = (await listServiceWorkspacesFor(db as never, found))!;
    expect(await pickServiceWorkspace(db as never, { fromPhone: PHONES.admin, body: "any tours this week?", workspaces })).toEqual({ kind: "ask", question: "Is this about Ambika or Vinod?" });
    expect(await pickServiceWorkspace(db as never, { fromPhone: PHONES.admin, body: "Vinod", workspaces })).toMatchObject({ kind: "chosen", workspace: { id: WS_V } });
    expect(await pickServiceWorkspace(db as never, { fromPhone: PHONES.admin, body: "and rent?", workspaces })).toMatchObject({ kind: "chosen", workspace: { id: WS_V } });
  });

  it("an admin whose phone is NOT verified is a stranger", async () => {
    db.tables.profiles!.find((p) => p.id === ADMIN)!.phone_verified_at = null;
    expect(await recognize(PHONES.admin)).toBeNull();
  });

  it("an admin phone that two verified accounts hold is a stranger (fail closed)", async () => {
    db.tables.profiles!.push(profile("twin", PHONES.admin));
    expect(await recognize(PHONES.admin)).toBeNull();
  });

  it("admin by legacy profiles.role alone (no profile_roles row) is not an admin here", async () => {
    db.tables.profile_roles = db.tables.profile_roles!.filter((r) => r.user_id !== ADMIN);
    expect(await recognize(PHONES.admin)).toBeNull();
  });

  it("an unreadable role table is not admin", async () => {
    const original = db.from.bind(db);
    db.from = ((table: string) => {
      if (table !== "profile_roles") return original(table);
      const failing = original(table) as unknown as Record<string, unknown>;
      return { ...failing, select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) }) } as never;
    }) as never;
    expect(await recognize(PHONES.admin)).toBeNull();
  });

  it("the verified Service-settings phone stays as an alias, even though several profiles share it", async () => {
    db.tables.profiles!.push(profile("twin", PHONES.so));
    expect(await recognize(PHONES.so)).toMatchObject({ basis: "admin", actorUserId: SO });
  });

  it("the same admin texting any other number is nobody here", async () => {
    expect(await recognize(PHONES.admin, { toPhone: "+12065550999" })).toBeNull();
  });

  it("a stranger, and an admin's phone with no match at all", async () => {
    expect(await recognize(PHONES.stranger)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("rule 2: a seat on a service workspace gets the delegated agent for that seat", () => {
  it("a full seat on an ATTACHED workspace (Ambika, owned by her): her workspace only, her assigned house only", async () => {
    const found = (await recognize(PHONES.staffFull))!;
    expect(found).toMatchObject({ serviceManager: true, basis: "seat", actorUserId: STAFF_FULL });
    expect(found.seats!.map((s) => s.workspace.id)).toEqual([WS_A]);
    const workspaces = (await listServiceWorkspacesFor(db as never, found))!;
    expect(workspaces.map((w) => w.id)).toEqual([WS_A]);

    const built = await buildServiceManagerAgentContext(db as never, { serviceOwnerId: STAFF_FULL, workspace: workspaces[0]!, seat: found.seats![0]! });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.ctx.userId).toBe(STAFF_FULL);
    expect(built.ctx.landlordId).toBe(CLIENT_A);
    expect(built.ctx.managerSmsAccess).toMatchObject({ mode: "delegated", assignedPropertyIds: ["prop-a1"], workspacePropertyIds: ["prop-a1"] });
    // prop-a2 is Ambika's but not this seat's.
    expect(built.ctx.workspace?.propertyIds).toEqual(["prop-a1"]);
    expect(built.ctx.managerSmsAccess?.readOnly).toBeUndefined();
    const writes = [...buildManagerSmsRegistry(built.ctx.managerSmsAccess).values()].filter((tool) => tool.kind === "write");
    expect(writes.length).toBeGreaterThan(0);
  });

  it("a Viewer seat is read-only: the registry holds no write tool at all, and reads are still there", async () => {
    const found = (await recognize(PHONES.staffView))!;
    expect(found.seats![0]).toMatchObject({ viewerRole: true });
    const built = await buildServiceManagerAgentContext(db as never, { serviceOwnerId: STAFF_VIEW, workspace: found.seats![0]!.workspace, seat: found.seats![0]! });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.ctx.managerSmsAccess).toMatchObject({ mode: "delegated", readOnly: true });
    expect(built.ctx.workspace?.propertyIds.sort()).toEqual(["prop-a1", "prop-a2"]);
    const registry = buildManagerSmsRegistry(built.ctx.managerSmsAccess);
    expect([...registry.values()].filter((tool) => tool.kind === "write")).toEqual([]);
    expect([...registry.values()].filter((tool) => tool.kind !== "write").length).toBeGreaterThan(0);
  });

  it("a seat whose role is not Viewer but whose grants are all view-only is read-only too", async () => {
    db.tables.account_link_invites!.find((i) => i.invitee_user_id === STAFF_FULL)!.team_role = "custom";
    db.tables.account_link_invites!.find((i) => i.invitee_user_id === STAFF_FULL)!.house_scope = "selected";
    db.tables.account_link_invites!.find((i) => i.invitee_user_id === STAFF_FULL)!.property_co_manager_permissions = { "prop-a1": { properties: { read: true } } };
    const found = (await recognize(PHONES.staffFull))!;
    const built = await buildServiceManagerAgentContext(db as never, { serviceOwnerId: STAFF_FULL, workspace: found.seats![0]!.workspace, seat: found.seats![0]! });
    expect(built.ok && built.ctx.managerSmsAccess?.readOnly).toBe(true);
  });

  it("a seat with no house in the workspace gets nothing", async () => {
    db.tables.account_link_invites!.find((i) => i.invitee_user_id === STAFF_FULL)!.assigned_property_ids = ["prop-elsewhere"];
    const found = (await recognize(PHONES.staffFull))!;
    expect(await buildServiceManagerAgentContext(db as never, { serviceOwnerId: STAFF_FULL, workspace: found.seats![0]!.workspace, seat: found.seats![0]! })).toEqual({ ok: false, reason: "no_houses" });
  });

  it("a seat is never an admin: the other service workspace is not theirs", async () => {
    const found = (await recognize(PHONES.staffFull))!;
    const vinod = (await listServiceWorkspacesFor(db as never, { basis: "admin" }))!.find((w) => w.id === WS_V)!;
    // Even handed the other workspace, a seat for Ambika does not build a context over Vinod.
    expect(await buildServiceManagerAgentContext(db as never, { serviceOwnerId: STAFF_FULL, workspace: vinod, seat: found.seats![0]! })).toEqual({ ok: false, reason: "no_houses" });
  });

  it("a seat on a workspace PropLane does not manage is not recognized here", async () => {
    expect(await recognize(PHONES.staffSelf)).toBeNull();
  });

  it("an unverified phone, or one two accounts hold, is nobody", async () => {
    db.tables.profiles!.find((p) => p.id === STAFF_FULL)!.phone_verified_at = null;
    expect(await recognize(PHONES.staffFull)).toBeNull();
    db = world();
    db.tables.profiles!.push(profile("twin", PHONES.staffFull));
    expect(await recognize(PHONES.staffFull)).toBeNull();
  });

  it("a seat on a workspace that stopped being managed drops out of their list", async () => {
    const found = (await recognize(PHONES.staffFull))!;
    db.tables.portal_workspaces!.find((w) => w.id === WS_A)!.is_service = false;
    expect(await listServiceWorkspacesFor(db as never, found)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("rule 9: self-serve managers, their teams, residents and vendors are not served on the line", () => {
  const member = (phone: string, body = "how are my houses doing") =>
    handleLineMemberText(db as never, { fromPhone: phone, body, phoneKey: phone.replace(/\D/g, "").slice(-10), mode: "service_line", lineOwnerUserId: SO });

  it("a self-serve manager with a PAID number is told to text it", async () => {
    state.entitled[SELF] = "paid";
    state.numbers[SELF] = "+15025550142";
    expect(await member(PHONES.self)).toMatchObject({
      handled: true,
      reply: "This line is for homes PropLane manages. Text your work number (502) 555-0142.",
      actorUserId: SELF,
    });
  });

  it("without a paid number: the pricing line (free, a signup trial, a lapsed plan and an unreadable entitlement alike)", async () => {
    for (const kind of ["lapsed", "trial", "unreadable"] as const) {
      state.entitled[SELF] = kind;
      state.numbers[SELF] = "+15025550142";
      const result = await member(PHONES.self);
      expect(result).toMatchObject({ handled: true, reply: "This line is for homes PropLane manages. A personal work number comes with Pro: proplane.ai/pricing" });
      expect(result.handled && result.reply).not.toContain("502");
    }
    // Paid but no number of their own yet: nothing to point at.
    state.entitled[SELF] = "paid";
    state.numbers[SELF] = null;
    expect(await member(PHONES.self)).toMatchObject({ reply: SELF_SERVE_PRICING_REPLY });
  });

  it("a status question gets no portfolio figure: nothing about the houses is read", async () => {
    state.entitled[SELF] = "paid";
    state.numbers[SELF] = "+15025550142";
    const result = await member(PHONES.self, "how much rent was collected");
    expect(result.handled && result.reply).not.toMatch(/rent collected|occupied|vacant|\$/i);
  });

  it("their team is told the same, naming the team's workspace owner's number", async () => {
    state.entitled[SELF] = "paid";
    state.numbers[SELF] = "+15025550142";
    expect(await member(PHONES.staffSelf)).toMatchObject({ handled: true, reply: "This line is for homes PropLane manages. Text your work number (502) 555-0142." });
  });

  it("a housing search from a self-serve manager is a prospect's: not handled, so the leasing assistant answers it", async () => {
    expect(await member(PHONES.self, "Any rooms near UW under $1,000?")).toEqual({ handled: false });
  });

  it("STOP, HUMAN and emergencies are never answered with the redirect", async () => {
    expect(await member(PHONES.self, "STOP")).toEqual({ handled: false });
    expect(await member(PHONES.self, "there is a fire")).toEqual({ handled: false });
  });

  it("a person who is also a client of a managed workspace is served as that client (status), not redirected", async () => {
    db.tables.portal_workspaces!.push({ id: "ws-self-managed", name: "Managed Too", owner_user_id: SELF, is_default: false, is_service: true });
    const result = await member(PHONES.self, "hi");
    expect(result.handled && result.reply).not.toContain("This line is for homes PropLane manages");
  });

  it("a self-serve resident is redirected to their manager's number; a resident of a managed home is not", async () => {
    state.entitled[SELF] = "paid";
    state.numbers[SELF] = "+15025550142";
    const self = await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.resSelf, body: "my sink is leaking" });
    expect(self).toMatchObject({ kind: "self_serve", reply: "This line is for homes PropLane manages. Text your work number (502) 555-0142.", actorUserId: RES_SELF });
    const managed = await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.resA, body: "my sink is leaking" });
    expect(managed).toBeNull();
  });

  it("a self-serve resident with no paid number gets the pricing line", async () => {
    const self = await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.resSelf, body: "hello" });
    expect(self).toMatchObject({ kind: "self_serve", reply: SELF_SERVE_PRICING_REPLY });
  });

  it("a self-serve resident looking for a new place is a prospect: not redirected", async () => {
    expect(await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.resSelf, body: "looking for another place to rent" })).toBeNull();
  });

  it("a vendor whose only open job is with a self-serve manager is redirected; one with a managed job, or asking for jobs, is not", async () => {
    state.entitled[SELF] = "paid";
    state.numbers[SELF] = "+15025550142";
    db.tables.agent_sessions!.push({ id: "s1", kind: "vendor_work_order", landlord_id: SELF, work_order_id: "wo-1", vendor_phone_e164: PHONES.vendorSelf, status: "active", updated_at: VERIFIED });
    db.tables.portal_work_order_records!.push({ id: "wo-1", property_id: "prop-s1", row_data: { propertyId: "prop-s1" } });
    const redirected = await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.vendorSelf, body: "I am on my way" });
    expect(redirected).toMatchObject({ kind: "self_serve", reply: "This line is for homes PropLane manages. Text your work number (502) 555-0142." });
    // "any jobs available" is the PropLane vendor board's, not the self-serve manager's.
    expect(await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.vendorSelf, body: "any jobs available in the area" })).toBeNull();
    // Add a managed job: now they are served by the managed flow.
    db.tables.agent_sessions!.push({ id: "s2", kind: "vendor_work_order", landlord_id: CLIENT_A, work_order_id: "wo-2", vendor_phone_e164: PHONES.vendorSelf, status: "active", updated_at: VERIFIED });
    db.tables.portal_work_order_records!.push({ id: "wo-2", property_id: "prop-a1", row_data: { propertyId: "prop-a1" } });
    expect(await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.vendorSelf, body: "I am on my way" })).toBeNull();
  });

  it("a stranger, a prospect and an unreadable workspace table fall through untouched", async () => {
    expect(await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.stranger, body: "Any rooms near UW under $1,000?" })).toBeNull();
    expect(await answerPropLaneLineText(db as never, { lineOwnerUserId: SO, toPhone: LINE, fromPhone: PHONES.stranger, body: "hi" })).toBeNull();
  });

  it("several workspaces, several numbers: all named; none paid: the pricing line", () => {
    expect(buildSelfServeLineReply(["+15025550142", "+12065550111", "+15025550142"])).toBe(
      "This line is for homes PropLane manages. Text your work number (502) 555-0142 or (206) 555-0111.",
    );
    expect(buildSelfServeLineReply([])).toBe(SELF_SERVE_PRICING_REPLY);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("rule 6: an unknown number's first text", () => {
  const roleArgs = (body: string, over: Record<string, unknown> = {}) => ({
    managerUserId: SO,
    fromPhone: PHONES.stranger,
    toPhone: LINE,
    messageSid: `SM${Math.random().toString(36).slice(2, 8)}`,
    body,
    ...over,
  });
  const ask = (body: string, over: Record<string, unknown> = {}) => handleRoleQuestionInbound(db as never, roleArgs(body, over) as never);

  it.each(["hi", "Hello?", "who is this", "hey"])("an unclear first text (%s) gets the exact question, once", async (text) => {
    const result = await ask(text);
    expect(result).toEqual({ handled: true, sent: true });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]!.text).toBe("Hi, this is PropLane. Are you a resident, a vendor, looking for a place, or want to manage your own property with PropLane?");
    expect(state.sent[0]!.text).toBe(PROPLANE_ROLE_QUESTION);
    expect(state.sent[0]!.to).toBe(PHONES.stranger);
    expect(state.sent[0]!.fromNumber).toBe(LINE);
    expect(db.tables.sms_onboarding_state![0]).toMatchObject({ phone_key: "2065550199" });
    expect(db.tables.sms_onboarding_state![0]!.asked_at).toBeTruthy();
  });

  it("a webhook retry of the same text says nothing twice", async () => {
    const args = roleArgs("hi");
    await handleRoleQuestionInbound(db as never, args as never);
    const retried = await handleRoleQuestionInbound(db as never, args as never);
    expect(retried).toEqual({ handled: true, sent: true });
    expect(state.sent).toHaveLength(1);
  });

  it.each(["Any rooms near UW under $1,000?", "I'm a plumber", "my sink is leaking", "I own 3 houses in Tacoma"])("a clear first text (%s) skips the question", async (text) => {
    expect(await ask(text)).toEqual({ handled: false });
    expect(state.sent).toEqual([]);
    expect(db.tables.sms_onboarding_state).toEqual([]);
  });

  it("a number we already texted is not a first text", async () => {
    db.tables.sms_outbox!.push({ id: "old", manager_user_id: SO, recipient_phone: PHONES.stranger });
    expect(await ask("hi")).toEqual({ handled: false });
    expect(state.sent).toEqual([]);
  });

  it("STOP and the other control words are never answered with the question", async () => {
    expect(await ask("STOP")).toEqual({ handled: false });
    expect(await ask("HELP")).toEqual({ handled: false });
  });

  it("a number that opted out gets nothing, but the text is still handled", async () => {
    state.suppressed = true;
    expect(await ask("hi")).toEqual({ handled: true, sent: true });
    expect(state.sent).toEqual([]);
  });

  describe("the answers", () => {
    beforeEach(async () => {
      await ask("hi");
      state.sent = [];
    });

    it("resident: told where to look (the resident lookup already found nobody)", async () => {
      expect(await ask("I'm a resident")).toEqual({ handled: true, sent: true });
      expect(state.sent[0]!.text).toBe(RESIDENT_NOT_FOUND_REPLY);
    });

    it("manage my own: the create-account link and the Pro line, and the role is saved", async () => {
      expect(await ask("manage my own property")).toEqual({ handled: true, sent: true });
      expect(state.sent[0]!.text).toBe("Great, set up your homes here: proplane.ai/auth/create-account?role=manager. A personal work number comes with Pro.");
      expect(state.sent[0]!.text).toBe(MANAGE_OWN_REPLY);
      expect(db.tables.sms_onboarding_state![0]).toMatchObject({ role: "landlord" });
    });

    it("looking for a place: handed to the leasing assistant (nothing sent here)", async () => {
      expect(await ask("looking for a place")).toEqual({ handled: false });
      expect(state.sent).toEqual([]);
      expect(db.tables.sms_onboarding_state![0]).toMatchObject({ role: "searcher" });
    });

    it("vendor: the PropLane line's vendor flow takes it (forced), and the role is saved", async () => {
      expect(await ask("vendor")).toEqual({ handled: false, forceVendor: true });
      expect(state.sent).toEqual([]);
      expect(db.tables.sms_onboarding_state![0]).toMatchObject({ role: "vendor" });
    });

    it("an answer that names no role goes down the normal path", async () => {
      expect(await ask("hmm not sure")).toEqual({ handled: false });
      expect(state.sent).toEqual([]);
    });

    it("an answer after the window, or when we never asked, is not an answer", async () => {
      db.tables.sms_onboarding_state![0]!.asked_at = new Date(Date.now() - ROLE_ANSWER_WINDOW_MS - 60_000).toISOString();
      expect(await ask("I'm a resident")).toEqual({ handled: false });
      db.tables.sms_onboarding_state = [];
      expect(await ask("I'm a resident")).toEqual({ handled: false });
    });
  });

  describe("on a manager's own work number", () => {
    const OWN = "+15025550177";
    beforeEach(() => {
      db.tables.manager_sms_numbers!.push({ id: "n2", manager_user_id: SELF, phone_number: OWN, provision_state: "active", released_at: null });
    });
    const askOwn = (body: string) => handleRoleQuestionInbound(db as never, roleArgs(body, { managerUserId: SELF, toPhone: OWN, workspaceId: WS_SELF }) as never);

    it("the question names the workspace instead of PropLane", async () => {
      expect(await askOwn("hi")).toEqual({ handled: true, sent: true });
      expect(state.sent[0]!.managerUserId).toBe(SELF);
      expect(state.sent[0]!.text).toBe("Hi, this is Elm Rentals. Are you a resident, a vendor, looking for a place, or want to manage your own property with PropLane?");
    });

    it("the name comes from the owner's default workspace when the line is not placed", async () => {
      await handleRoleQuestionInbound(db as never, roleArgs("hi", { managerUserId: SELF, toPhone: OWN }) as never);
      expect(state.sent[0]!.text).toContain("Hi, this is Elm Rentals.");
    });

    it("a vendor answer is asked for their trade and area; a clear first text is untouched", async () => {
      await askOwn("hi");
      state.sent = [];
      expect(await askOwn("vendor")).toEqual({ handled: true, sent: true });
      expect(state.sent[0]!.text).toBe(VENDOR_TRADE_QUESTION);
      expect(await handleRoleQuestionInbound(db as never, roleArgs("Any rooms near UW?", { managerUserId: SELF, toPhone: OWN }) as never)).toEqual({ handled: false });
    });
  });

  it("the shared number is the router's, not this block's", async () => {
    db.tables.sms_runtime_config = [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550000", shared_pilot_workspace_ids: [] }];
    db.tables.manager_sms_numbers = [];
    expect(await ask("hi", { toPhone: "+12065550000" })).toEqual({ handled: false });
    expect(state.sent).toEqual([]);
  });

  it("a text with no sid or no phone changes nothing", async () => {
    expect(await ask("hi", { messageSid: "" })).toEqual({ handled: false });
    expect(await ask("hi", { fromPhone: "" })).toEqual({ handled: false });
    expect(state.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("rules 7 and 8: a self-serve home asked about on the line, through the real entitlement", () => {
  const listing = (id: string, address: string, extra: Partial<MockProperty> = {}) =>
    ({ id, address, title: address.split(",")[0], buildingName: "", neighborhood: "", managerUserId: `mgr-${id}`, workspaceId: `ws-${id}`, ...extra }) as unknown as MockProperty;
  const ELM = listing("elm", "12 Elm St, Louisville, KY 40202");
  const BROOKLYN = listing("brooklyn", "5259 Brooklyn Ave NE, Seattle, WA 98105", { workspaceId: WS_A });
  const deps = { serviceListings: async () => [BROOKLYN], serviceWorkspaceIds: async () => [WS_A], allListings: async () => [BROOKLYN, ELM] };
  const NONE = "I can only help with homes PropLane manages. Looking for a place in Seattle? Tell me your area, budget and move-in date.";

  it("Kentucky: a paid personal number is named, and only that", async () => {
    state.entitled["mgr-elm"] = "paid";
    state.numbers["mgr-elm"] = "+15025550142";
    expect(await resolveHouseRedirect(db as never, "Is 12 Elm St still available?", deps)).toBe("For 12 Elm St, Louisville, text (502) 555-0142.");
  });

  it.each(["trial", "lapsed", "unreadable"] as const)("a %s entitlement gets nothing: no number, no street, no link, no name", async (kind) => {
    state.entitled["mgr-elm"] = kind;
    state.numbers["mgr-elm"] = "+15025550142";
    const reply = await resolveHouseRedirect(db as never, "Is 12 Elm St still available?", deps);
    expect(reply).toBe(NONE);
    expect(reply).not.toMatch(/elm|louisville|12|502|https?:|proplane\.ai|rent\/listings/i);
  });

  it("paid but with no number of their own to send from: nothing", async () => {
    state.entitled["mgr-elm"] = "paid";
    state.numbers["mgr-elm"] = null;
    expect(await resolveHouseRedirect(db as never, "12 Elm St?", deps)).toBe(NONE);
  });

  it("a home that PropLane manages is left to the line's own flow", async () => {
    state.entitled["mgr-brooklyn"] = "paid";
    state.numbers["mgr-brooklyn"] = "+12065550111";
    expect(await resolveHouseRedirect(db as never, "Is 5259 Brooklyn Ave NE available?", deps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the line mode stays per_workspace", () => {
  it("nothing here turns the shared line on or reads a different mode", () => {
    expect((db.tables.sms_runtime_config![0] as Row).line_mode).toBe("per_workspace");
  });
});
