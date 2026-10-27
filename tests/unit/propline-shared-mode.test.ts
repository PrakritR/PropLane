/**
 * The PropLane line in SHARED mode (`sms_runtime_config.line_mode = 'shared'`): the 206 is every free or trial manager's work
 * number with full service. A matrix against fixtures, next to the per_workspace rules in propline-line-policy.test.ts (which
 * must keep passing unchanged):
 *
 *   free manager / teammate / resident / vendor / prospect   routed to their own workspace, fully served
 *   a workspace WITH a personal number                       redirected in both modes (never routed on the 206)
 *   a home without a personal number                         in the line catalog, no "I can only help" reply
 *   the "no info / upgrade" replies                          per_workspace only
 *   the "manage my own" answer                               "You'll text from this number until you get your own."
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";
import type { SharedLineConfig, SharedLineInbound } from "@/lib/one-number/contracts";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";
import { fakeSharedLineDb, type FakeRow } from "../helpers/shared-line-fake-db";

const state = vi.hoisted(() => ({
  entitled: {} as Record<string, "paid" | "lapsed">,
  numbers: {} as Record<string, string | null>,
  serviceListings: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: async (_db: unknown, id: string) =>
    state.entitled[id] === "paid" ? { ok: true, entitled: true, via: "add_on", tier: "free" } : { ok: true, entitled: false, tier: "free" },
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/sms/manager-number-provisioning.server")>();
  return { ...actual, resolveActiveManagerSendNumber: async (_db: unknown, id: string) => state.numbers[id] ?? null };
});
vi.mock("@/lib/service/service-catalog.server", () => ({
  getServicePublicListings: vi.fn(async () => state.serviceListings),
  loadServiceWorkspaceIds: vi.fn(async () => ["ws-service"]),
}));
const handleUnassigned = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ leadId: "lead-1" as string | null, reply: "Hi! What is your budget?" as string | null, assignedWorkspaceId: null as string | null })));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: handleUnassigned }));

import { handleLineMemberText } from "@/lib/one-number/line-member-status.server";
import { getLineCatalogListings, getLineOfferListings, sharedLineCatalogListings, sharedLineOfferListings } from "@/lib/one-number/line-catalog.server";
import { NO_PAID_NUMBER_HOME_REPLY, resolveHouseRedirect } from "@/lib/one-number/house-redirect.server";
import { routeSharedLineInboundWithReply } from "@/lib/one-number/router.server";
import { MANAGE_OWN_REPLY, MANAGE_OWN_SHARED_REPLY } from "@/lib/sms/propline-first-text";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const SO = "so";
const FREE = "free-mgr";
const PAID = "paid-mgr";
const TEAMMATE = "teammate";
const RES_FREE = "res-free";
const VENDOR_FREE = "vendor-free";
const PHONES = { free: "+12065550201", teammate: "+12065550202", resFree: "+12065550203", vendorFree: "+12065550204", stranger: "+12065550299", paid: "+12065550205" };
const SHARED: SharedLineConfig = {
  mode: "shared", sharedNumber: "+12066781909", messagingServiceSid: "MG1", pilotWorkspaceIds: [], dedicatedWorkspaceIds: ["ws-paid"],
};
const PER_WORKSPACE: SharedLineConfig = { mode: "per_workspace", sharedNumber: null, messagingServiceSid: null, pilotWorkspaceIds: [] };

const home = (id: string, address: string, workspaceId: string, over: Partial<MockProperty> = {}) =>
  ({ id, address, workspaceId, managerUserId: workspaceId === "ws-paid" ? PAID : FREE, title: address, buildingName: address, ...over }) as unknown as MockProperty;
const SERVICE_HOME = home("svc", "5259 Brooklyn Ave NE, Seattle, WA 98105", "ws-service");
const FREE_HOME = home("free", "12 Elm St, Louisville, KY 40202", "ws-free");
const PAID_HOME = home("paid", "77 Oakwood Dr, Seattle, WA 98115", "ws-paid");
const NO_WS_HOME = home("orphan", "9 Birch Ln, Seattle, WA 98101", "");
const allListings = async () => [SERVICE_HOME, FREE_HOME, PAID_HOME, NO_WS_HOME];

beforeEach(() => {
  state.entitled = {};
  state.numbers = {};
  state.serviceListings = [SERVICE_HOME];
  handleUnassigned.mockClear();
});

describe("the line catalog", () => {
  const deps = { allListings, serviceWorkspaceIds: async () => ["ws-service"] };

  it("shared: managed homes plus every home WITHOUT a personal number; a personal-number home and an unstamped home are out", async () => {
    const listings = await sharedLineCatalogListings({} as never, SHARED, deps);
    expect(listings.map((p) => p.id).sort()).toEqual(["free", "svc"]);
  });

  it("shared with a pilot list: only the pilot's workspaces (managed ones always)", async () => {
    const listings = await sharedLineCatalogListings({} as never, { ...SHARED, pilotWorkspaceIds: ["ws-other"] }, deps);
    expect(listings.map((p) => p.id)).toEqual(["svc"]);
  });

  it("per_workspace: the managed homes only, exactly as before", async () => {
    const listings = await getLineCatalogListings({} as never, PER_WORKSPACE, deps);
    expect(listings).toEqual([SERVICE_HOME]);
  });
});

describe("home questions", () => {
  const base = { allListings, serviceWorkspaceIds: async () => ["ws-service"], paidNumberOf: async (l: MockProperty) => (l.workspaceId === "ws-paid" ? "+15025550142" : null) };

  it("shared: a free manager's home is served (no redirect, no 'I can only help' reply); a managed home is too", async () => {
    const served = async () => [SERVICE_HOME, FREE_HOME];
    expect(await resolveHouseRedirect({} as never, "is 12 Elm St still available?", { ...base, serviceListings: served, shared: SHARED })).toBeNull();
    expect(await resolveHouseRedirect({} as never, "tell me about 5259 Brooklyn", { ...base, serviceListings: served, shared: SHARED })).toBeNull();
  });

  it("shared: a home whose manager has a personal number is NOT redirected on a mere mention (the lead flow gives the number on interest)", async () => {
    const paidNumberOf = vi.fn(base.paidNumberOf);
    const reply = await resolveHouseRedirect({} as never, "is 77 Oakwood Dr open?", { ...base, paidNumberOf, serviceListings: async () => [SERVICE_HOME, FREE_HOME], shared: SHARED });
    expect(reply).toBeNull();
    expect(paidNumberOf).not.toHaveBeenCalled();
  });

  it("shared: the stranger offer catalog adds the personal-number home, tagged paid, next to managed and free", async () => {
    const offered = await sharedLineOfferListings({} as never, SHARED, { allListings, serviceWorkspaceIds: async () => ["ws-service"] });
    expect(offered.map((p) => [p.id, p.lineTier]).sort()).toEqual([["free", "free"], ["paid", "paid"], ["svc", "managed"]]);
    // The line's served catalog (no paid home) is unchanged.
    expect((await sharedLineCatalogListings({} as never, SHARED, { allListings, serviceWorkspaceIds: async () => ["ws-service"] })).map((p) => p.id).sort()).toEqual(["free", "svc"]);
    // per_workspace: managed only, tagged managed.
    state.serviceListings = [SERVICE_HOME];
    expect((await getLineOfferListings({} as never, PER_WORKSPACE)).map((p) => [p.id, p.lineTier])).toEqual([["svc", "managed"]]);
  });

  it("shared: a personal-number home whose number cannot be named says nothing here (the lead flow answers)", async () => {
    const reply = await resolveHouseRedirect({} as never, "is 77 Oakwood Dr open?", { ...base, paidNumberOf: async () => null, serviceListings: async () => [SERVICE_HOME], shared: SHARED });
    expect(reply).toBeNull();
  });

  it("per_workspace is unchanged: the same free home gets the reply that names nothing, a paid home its number", async () => {
    const deps = { ...base, serviceListings: async () => [SERVICE_HOME], paidNumberOf: async (l: MockProperty) => (l.workspaceId === "ws-paid" ? "+15025550142" : null) };
    expect(await resolveHouseRedirect({} as never, "is 12 Elm St still available?", { ...deps, shared: PER_WORKSPACE })).toBe(NO_PAID_NUMBER_HOME_REPLY);
    expect(await resolveHouseRedirect({} as never, "is 12 Elm St still available?", deps)).toBe(NO_PAID_NUMBER_HOME_REPLY);
    expect(await resolveHouseRedirect({} as never, "is 77 Oakwood Dr open?", deps)).toBe("For 77 Oakwood Dr, Seattle, text (502) 555-0142.");
  });
});

describe("the member status handler is per_workspace policy only", () => {
  let db: FakeDb;
  const profile = (id: string, phone: string): Row => ({ id, email: `${id}@x.com`, phone, phone_verified_at: VERIFIED });
  beforeEach(() => {
    db = createFakeDb({
      portal_workspaces: [{ id: "ws-free", name: "Elm Rentals", owner_user_id: FREE, is_default: true, is_service: false }],
      profiles: [profile(FREE, PHONES.free)],
      account_link_invites: [],
      manager_property_records: [],
    });
  });
  const member = (mode: "service_line" | "shared_line") =>
    handleLineMemberText(db as never, { fromPhone: PHONES.free, body: "how are my houses doing", phoneKey: "2065550201", mode, lineOwnerUserId: SO });

  it("per_workspace: a free manager gets the pricing reply", async () => {
    expect(await member("service_line")).toMatchObject({ handled: true, reply: "This line is for homes PropLane manages. A personal work number comes with Pro: proplane.ai/pricing" });
  });

  it("shared: the same manager is never told that; the router serves them with the full assistant instead", async () => {
    expect(await member("shared_line")).toEqual({ handled: false });
  });
});

describe("shared-line routing: who is fully served", () => {
  const inbound = (fromPhone: string, body: string): SharedLineInbound => ({ fromPhone, phoneKey: fromPhone.replace(/\D/g, "").slice(-10), body, messageSid: "SM1", mediaCount: 0 });
  const world = (extra: Record<string, FakeRow[]> = {}) =>
    fakeSharedLineDb({
      portal_workspaces: [
        { id: "ws-free", name: "Elm Rentals", owner_user_id: FREE, is_default: true, is_service: false },
        { id: "ws-paid", name: "Oak Homes", owner_user_id: PAID, is_default: true, is_service: false },
      ],
      manager_property_records: [
        { id: "prop-free", manager_user_id: FREE, workspace_id: "ws-free", row_data: { address: "12 Elm St, Louisville, KY 40202" } },
        { id: "prop-paid", manager_user_id: PAID, workspace_id: "ws-paid", row_data: { address: "77 Oakwood Dr, Seattle, WA 98115" } },
      ],
      profiles: [
        { id: FREE, email: "f@x.com", phone: PHONES.free, phone_verified_at: VERIFIED },
        { id: PAID, email: "p@x.com", phone: PHONES.paid, phone_verified_at: VERIFIED },
        { id: TEAMMATE, email: "t@x.com", phone: PHONES.teammate, phone_verified_at: VERIFIED },
        { id: RES_FREE, email: "r@x.com", phone: PHONES.resFree, phone_verified_at: VERIFIED },
        { id: VENDOR_FREE, email: "v@x.com", phone: PHONES.vendorFree, phone_verified_at: VERIFIED },
      ],
      account_link_invites: [
        { id: "inv-1", invitee_user_id: TEAMMATE, inviter_user_id: FREE, workspace_id: "ws-free", status: "accepted", team_role: "property_manager" },
      ],
      manager_application_records: [
        { id: "app-1", manager_user_id: FREE, resident_email: "r@x.com", property_id: "prop-free", row_data: { bucket: "approved" } },
      ],
      agent_sessions: [
        { id: "s1", kind: "vendor_work_order", vendor_phone_e164: PHONES.vendorFree, landlord_id: FREE, work_order_id: "wo-1", status: "active" },
      ],
      portal_work_order_records: [{ id: "wo-1", property_id: "prop-free", row_data: {} }],
      ...extra,
    });
  const route = (fromPhone: string, body: string, db: ReturnType<typeof world>, dedicated: string[] = ["ws-paid"]) =>
    routeSharedLineInboundWithReply(db.db, inbound(fromPhone, body), null, { dedicatedWorkspaceIds: dedicated });

  it("a free manager is routed to their own workspace as the manager", async () => {
    const { decision } = await route(PHONES.free, "how are my houses doing", world());
    expect(decision).toMatchObject({ kind: "routed", workspaceId: "ws-free", ownerUserId: FREE, role: "manager" });
  });

  it("a free manager's teammate is routed to that workspace as a manager", async () => {
    const { decision } = await route(PHONES.teammate, "rent status", world());
    expect(decision).toMatchObject({ kind: "routed", workspaceId: "ws-free", role: "manager" });
  });

  it("a free manager's resident and vendor are routed to their normal flows in that workspace", async () => {
    const resident = await route(PHONES.resFree, "when is rent due", world());
    expect(resident.decision).toMatchObject({ kind: "routed", workspaceId: "ws-free", role: "resident" });
    const vendor = await route(PHONES.vendorFree, "I am on my way", world());
    expect(vendor.decision).toMatchObject({ kind: "routed", workspaceId: "ws-free", role: "vendor" });
  });

  it("a prospect (a stranger) goes to the lead flow, which now shows free managers' homes", async () => {
    const out = await route(PHONES.stranger, "any rooms near UW?", world());
    expect(out.decision).toMatchObject({ kind: "unassigned" });
    expect(handleUnassigned).toHaveBeenCalledTimes(1);
  });

  it("a workspace WITH a personal number is never routed on the 206: its people get the redirect", async () => {
    const db = world({ account_link_invites: [{ id: "inv-p", invitee_user_id: TEAMMATE, inviter_user_id: PAID, workspace_id: "ws-paid", status: "accepted", team_role: "property_manager" }] });
    const out = await route(PHONES.teammate, "rent status", db);
    expect(out.dedicatedRedirect).toMatchObject({ workspaceId: "ws-paid" });
    expect(out.decision).toMatchObject({ kind: "unassigned" });
    expect(handleUnassigned).not.toHaveBeenCalled();
  });
});

describe("the 'manage my own' answer", () => {
  it("shared: you text from this number until you get your own; per_workspace keeps its Pro wording", () => {
    expect(MANAGE_OWN_SHARED_REPLY).toBe("Set up your homes here: https://proplane.ai/auth/create-account?role=manager You'll text from this number until you get your own.");
    expect(MANAGE_OWN_REPLY).toBe("Great, set up your homes here: https://proplane.ai/auth/create-account?role=manager A personal work number comes with Pro.");
    // Nothing is glued to the end of the address, so a phone cannot swallow a period into the link.
    expect(MANAGE_OWN_SHARED_REPLY).toMatch(/role=manager You/);
  });
});
