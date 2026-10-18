// The routes around the lead system: the admin-only queue and the manager entry-code routes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEAD_CONSTRAINTS, leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  db: null as unknown,
  ctx: null as unknown,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async (id: string) => state.admins.has(id) }));
vi.mock("@/lib/seo/public-catalog.server", () => ({
  getCrawlPublicListings: async () => [{ id: "prop-1", title: "Brooklyn House", buildingName: "Brooklyn House", address: "4000 15th Ave NE" }],
}));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: async () => null }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: async () => true }));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: async () => ({ ok: true }) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: async () => ({ sent: true }) }));
vi.mock("@/lib/listing-channels/route-context.server", () => ({
  resolveListingChannelContext: async () => state.ctx,
  propertyInWorkspace: async (_db: unknown, workspace: { id: string; ownerUserId: string; propertyIds: string[] }, propertyId: string) => {
    const rows = ((state.db as LeadFakeDb["db"]) as unknown as { from: (t: string) => { select: () => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: Record<string, unknown> | null }> } } } });
    const { data } = await rows.from("manager_property_records").select().eq("id", propertyId).maybeSingle();
    if (!data || !workspace.propertyIds.includes(propertyId)) return null;
    return String(data.workspace_id) === workspace.id && String(data.manager_user_id) === workspace.ownerUserId ? { id: propertyId, live: true } : null;
  },
}));

import { GET as adminList } from "@/app/api/admin/unassigned-leads/route";
import { PATCH as adminPatch } from "@/app/api/admin/unassigned-leads/[id]/route";
import { GET as codesGet, POST as codesPost } from "@/app/api/portal/one-number/entry-codes/route";
import { PATCH as codesPatch } from "@/app/api/portal/one-number/entry-codes/[code]/route";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD_ID = "99999999-9999-4999-8999-999999999999";

function seed(mode = "shared"): LeadFakeDb {
  return leadFakeDb(
    {
      sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: "+12065550100" }],
      portal_workspaces: [
        { id: WS_A, name: "A team", owner_user_id: OWNER_A, is_default: true },
        { id: WS_B, name: "B team", owner_user_id: OWNER_B, is_default: true },
      ],
      manager_property_records: [
        { id: "prop-1", workspace_id: WS_A, manager_user_id: OWNER_A, status: "live", property_data: { address: "5259 Brooklyn Ave NE, Seattle", buildingName: "Brooklyn House" } },
        { id: "prop-b", workspace_id: WS_B, manager_user_id: OWNER_B, status: "live", property_data: { address: "9 Pine St, Seattle", buildingName: "Pine House" } },
      ],
      sms_entry_codes: [{ code: "PINE9", workspace_id: WS_B, owner_user_id: OWNER_B, property_id: "prop-b", active: true, created_at: "2026-10-01" }],
      sms_unassigned_leads: [
        { id: LEAD_ID, phone_key: "2065550142", status: "open", profile: { stage: "offered", budgetMax: 1000, moveInDate: "2026-11-01" }, last_inbound_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T12:00:00Z" },
      ],
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

const json = (method: string, body: unknown) => new Request("https://proplane.ai/api/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

beforeEach(() => {
  state.user = null;
  state.admins = new Set();
  state.db = seed().db;
  state.ctx = null;
});

describe("the Unassigned-leads queue is platform-admin only", () => {
  it("answers 401 signed out and 403 to a manager, on every verb", async () => {
    expect((await adminList(new Request("https://proplane.ai/api/admin/unassigned-leads"))).status).toBe(401);
    expect((await adminPatch(json("PATCH", { action: "close" }), params({ id: LEAD_ID }))).status).toBe(401);
    state.user = { id: OWNER_A };
    expect((await adminList(new Request("https://proplane.ai/api/admin/unassigned-leads"))).status).toBe(403);
    expect((await adminPatch(json("PATCH", { action: "close" }), params({ id: LEAD_ID }))).status).toBe(403);
    expect((await adminPatch(json("PATCH", { action: "assign", propertyId: "prop-1" }), params({ id: LEAD_ID }))).status).toBe(403);
    const fake = state.db as LeadFakeDb["db"];
    expect(fake).toBeTruthy();
  });

  it("lists open leads with the phone masked, plus the houses for the Assign popup", async () => {
    state.user = { id: "admin-1" };
    state.admins.add("admin-1");
    const res = await adminList(new Request("https://proplane.ai/api/admin/unassigned-leads?houses=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ id: LEAD_ID, phoneMasked: "•••• 0142", budgetMax: 1000, moveInDate: "2026-11-01", stage: "offered" });
    expect(JSON.stringify(body)).not.toContain("2065550142");
    expect(body.houses).toEqual([{ id: "prop-1", label: "Brooklyn House - 4000 15th Ave NE" }]);
  });

  it("assign uses the same path as a prospect's pick; close takes the lead out", async () => {
    state.user = { id: "admin-1" };
    state.admins.add("admin-1");
    const bad = await adminPatch(json("PATCH", { action: "assign" }), params({ id: LEAD_ID }));
    expect(bad.status).toBe(400);
    const missing = await adminPatch(json("PATCH", { action: "assign", propertyId: "nope" }), params({ id: LEAD_ID }));
    expect(missing.status).toBe(404);
    const ok = await adminPatch(json("PATCH", { action: "assign", propertyId: "prop-1" }), params({ id: LEAD_ID }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, label: "Brooklyn House" });
    const again = await adminPatch(json("PATCH", { action: "assign", propertyId: "prop-1" }), params({ id: LEAD_ID }));
    expect(again.status).toBe(409);
    expect((await adminPatch(json("PATCH", { action: "close" }), params({ id: LEAD_ID }))).status).toBe(409);
    expect((await adminPatch(json("PATCH", { action: "dance" }), params({ id: LEAD_ID }))).status).toBe(400);
    expect((await adminPatch(json("PATCH", { action: "close" }), params({ id: "not-a-uuid" }))).status).toBe(404);
  });
});

describe("manager entry-code routes", () => {
  const ctxFor = (workspaceId: string, ownerUserId: string, propertyIds: string[]) => ({
    db: state.db,
    userId: ownerUserId,
    workspace: { id: workspaceId, name: "ws", ownerUserId, owned: true, isDefault: true, propertyIds },
  });

  it("does not exist while the line is per-workspace: 404 on every verb", async () => {
    state.db = seed("per_workspace").db;
    state.ctx = ctxFor(WS_A, OWNER_A, ["prop-1"]);
    expect((await codesGet(new Request("https://proplane.ai/api/portal/one-number/entry-codes?propertyId=prop-1"))).status).toBe(404);
    expect((await codesPost(json("POST", { propertyId: "prop-1" }))).status).toBe(404);
    expect((await codesPatch(json("PATCH", { active: false }), params({ code: "PINE9" }))).status).toBe(404);
  });

  it("401 when nobody is signed in", async () => {
    state.ctx = null;
    expect((await codesGet(new Request("https://proplane.ai/api/portal/one-number/entry-codes"))).status).toBe(401);
    expect((await codesPost(json("POST", { propertyId: "prop-1" }))).status).toBe(401);
  });

  it("creates the suggested code for a house of the signed-in workspace and returns the call to action", async () => {
    state.ctx = ctxFor(WS_A, OWNER_A, ["prop-1"]);
    const list = await codesGet(new Request("https://proplane.ai/api/portal/one-number/entry-codes?propertyId=prop-1"));
    expect(await list.json()).toMatchObject({ sharedNumber: "+12065550100", codes: [], suggestion: "BROOKLYN5" });
    const res = await codesPost(json("POST", { propertyId: "prop-1" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      code: { code: "BROOKLYN5", propertyId: "prop-1", active: true, callToAction: "Text BROOKLYN5 to (206) 555-0100", smsLink: "sms:+12065550100?&body=BROOKLYN5" },
    });
    const after = await (await codesGet(new Request("https://proplane.ai/api/portal/one-number/entry-codes?propertyId=prop-1"))).json();
    expect(after.codes).toHaveLength(1);
    expect(after.suggestion).toBeNull();
  });

  it("refuses a reserved word (400), a taken code (409) and a bad shape (400), with a reason", async () => {
    state.ctx = ctxFor(WS_A, OWNER_A, ["prop-1"]);
    const reserved = await codesPost(json("POST", { propertyId: "prop-1", code: "HUMAN" }));
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toMatchObject({ reason: "reserved" });
    const taken = await codesPost(json("POST", { propertyId: "prop-1", code: "pine9" }));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ reason: "taken" });
    expect((await codesPost(json("POST", { propertyId: "prop-1", code: "x" }))).status).toBe(400);
  });

  it("a manager cannot mint, read or switch off another workspace's codes", async () => {
    state.ctx = ctxFor(WS_A, OWNER_A, ["prop-1"]);
    // Another workspace's house: not found, exactly like a house that does not exist.
    expect((await codesPost(json("POST", { propertyId: "prop-b", code: "STEAL1" }))).status).toBe(404);
    expect((await codesGet(new Request("https://proplane.ai/api/portal/one-number/entry-codes?propertyId=prop-b"))).status).toBe(404);
    // The whole-workspace listing never includes it.
    const all = await (await codesGet(new Request("https://proplane.ai/api/portal/one-number/entry-codes"))).json();
    expect(all.codes.map((c: { code: string }) => c.code)).not.toContain("PINE9");
    // Switching off a code that is not theirs reads as not found, and the code stays live.
    const res = await codesPatch(json("PATCH", { active: false }), params({ code: "PINE9" }));
    expect(res.status).toBe(404);
    const fake = state.db as unknown as { from: (t: string) => { select: () => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: { active: boolean } }> } } } };
    expect((await fake.from("sms_entry_codes").select().eq("code", "PINE9").maybeSingle()).data.active).toBe(true);
  });

  it("switches off its own code", async () => {
    state.ctx = ctxFor(WS_B, OWNER_B, ["prop-b"]);
    const res = await codesPatch(json("PATCH", { active: false }), params({ code: "pine9" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: { code: "PINE9", active: false } });
    expect((await codesPatch(json("PATCH", { active: "no" }), params({ code: "PINE9" }))).status).toBe(400);
  });
});
