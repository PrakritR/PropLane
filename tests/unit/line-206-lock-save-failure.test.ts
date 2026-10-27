// Finding: the home lock must be PERSISTED before anything tells the prospect (or a workspace) the home is theirs. A failed
// (false) or thrown sms_line_sessions save leaves the previous lock and assignment untouched and sends a neutral retry line.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig, SharedLineInbound } from "@/lib/one-number/contracts";
import { LEAD_CONSTRAINTS, leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";
import { storedListing } from "../helpers/lead-listing-fixtures";

const WS_SVC = "11111111-1111-4111-8111-111111111111";
const WS_LENA = "22222222-2222-4222-8222-222222222222";
const WS_MARCUS = "33333333-3333-4333-8333-333333333333";
const WS_OTHER = "44444444-4444-4444-8444-444444444444";
const OWNER_SVC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_LENA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_MARCUS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PHONE_KEY = "2065550177";
const PHONE = "+12065550177";
const MARCUS_NUMBER = "+12065550142";
const NOW = new Date("2026-10-26T20:00:00Z");

const SHARED: SharedLineConfig = { mode: "shared", sharedNumber: "+12066781909", messagingServiceSid: "MG1", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [WS_MARCUS] };

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{ workspaceId: string; direction: string; body: string; messageSid: string }>,
  alerts: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: vi.fn(), lookupRecordTestWorkspaceId: vi.fn(async () => null) }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/service/service-manager-alerts.server", () => ({ alertServiceManagerOfInquiry: vi.fn(async () => undefined) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  logManagerSmsMessage: async (_db: unknown, args: { workspaceId?: string | null; direction: string; body: string; messageSid?: string | null }) => {
    mocks.messages.push({ workspaceId: String(args.workspaceId ?? ""), direction: args.direction, body: args.body, messageSid: String(args.messageSid ?? "") });
    return true;
  },
}));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({
  upsertManagerSmsContact: async (db: { from: (t: string) => { insert: (r: unknown) => Promise<unknown> } }, args: { managerUserId: string; phone: string; counterpartyRole: string }) => {
    await db.from("manager_sms_contacts").insert({ manager_user_id: args.managerUserId, phone_e164: args.phone, counterparty_role: args.counterpartyRole });
    return { ok: true };
  },
}));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: async (_db: unknown, args: unknown) => { mocks.alerts.push(args); return { sent: true }; } }));
vi.mock("@/lib/one-number/config.server", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/one-number/config.server")>();
  return { ...actual, loadSharedLineConfig: async () => SHARED };
});

import { assignLeadToHouse } from "@/lib/one-number/unassigned-leads.server";
import { loadSharedLineSession } from "@/lib/one-number/session.server";
import { routeSharedLineInboundWithReply, type SharedLineRouteResult } from "@/lib/one-number/router.server";
import { publicListingProjection } from "@/lib/public-listings.server";
import type { LineListing, LineTier } from "@/lib/one-number/line-tier";

const home = (id: string, tier: LineTier, manager: string, workspaceId: string, over: { rent: number; street: string; name: string; neighborhood?: string }): LineListing => ({
  ...publicListingProjection(storedListing(id, { manager, neighborhood: over.neighborhood ?? "University District", beds: 4, rent: over.rent, street: over.street, name: over.name })),
  workspaceId,
  lineTier: tier,
});

const SVC_HOME = home("prop-4709a", "managed", OWNER_SVC, WS_SVC, { rent: 1050, street: "4709A 8th Ave NE", name: "Eighth Avenue House" });
const LENA_HOME = home("prop-roosevelt", "free", OWNER_LENA, WS_LENA, { rent: 1100, street: "5020 Roosevelt Way NE", name: "Roosevelt Way House" });
const MARCUS_HOME = home("prop-ravenna", "paid", OWNER_MARCUS, WS_MARCUS, { rent: 1195, street: "12 Ravenna Pl", name: "Ravenna Place House" });
// Capitol Hill: outside "near UW", so they only matter for the narrowing tests.
const FAR = (n: number, tier: LineTier, owner: string, ws: string) => home(`prop-far-${n}`, tier, owner, ws, { rent: 1000 + n * 10, street: `${100 + n} Pine St`, name: `Pine Street ${n} House`, neighborhood: "Capitol Hill" });

let catalog: LineListing[] = [];
const listings = async () => catalog;

function seed(): LeadFakeDb {
  return leadFakeDb(
    {
      portal_workspaces: [
        { id: WS_SVC, name: "PropLane homes", owner_user_id: OWNER_SVC, is_default: true, is_service: true },
        { id: WS_LENA, name: "Lena Rentals", owner_user_id: OWNER_LENA, is_default: true, is_service: false },
        { id: WS_MARCUS, name: "Marcus Homes", owner_user_id: OWNER_MARCUS, is_default: true, is_service: false },
        { id: WS_OTHER, name: "Other Co", owner_user_id: OWNER_OTHER, is_default: true, is_service: false },
      ],
      manager_property_records: [
        { id: "prop-4709a", workspace_id: WS_SVC, manager_user_id: OWNER_SVC, status: "live", property_data: { address: "4709A 8th Ave NE, Seattle, WA", buildingName: "Eighth Avenue House" } },
        { id: "prop-roosevelt", workspace_id: WS_LENA, manager_user_id: OWNER_LENA, status: "live", property_data: { address: "5020 Roosevelt Way NE, Seattle, WA", buildingName: "Roosevelt Way House" } },
        { id: "prop-ravenna", workspace_id: WS_MARCUS, manager_user_id: OWNER_MARCUS, status: "live", property_data: { address: "12 Ravenna Pl, Seattle, WA", buildingName: "Ravenna Place House" } },
      ],
      profiles: [{ id: OWNER_MARCUS, full_name: "Marcus Webb" }],
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}


const RETRY = "I could not check rooms just now. Text me again in a minute and I will try again.";

let fake: LeadFakeDb;
let sid = 0;
/** What an sms_line_sessions write does right now: fine, resolves with an error (a false save), or throws. */
let saveMode: "ok" | "error" | "throw" = "ok";

const failing = () => {
  if (saveMode === "throw") return Promise.reject(new Error("connection reset"));
  return Promise.resolve({ data: null, error: { code: "57014", message: "statement timeout" } });
};
/** Every WRITE to sms_line_sessions (upsert, insert, update, delete) fails in the chosen way; reads pass through. */
const flaky = (inner: LeadFakeDb["db"]) =>
  ({
    ...(inner as object),
    from(table: string) {
      const builder = (inner as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
      if (table !== "sms_line_sessions" || saveMode === "ok") return builder;
      const dead: Record<string, unknown> = { eq: () => dead, is: () => dead, select: () => dead, then: (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => failing().then(a, r) };
      return { ...builder, upsert: () => dead, insert: () => dead, update: () => dead, delete: () => dead };
    },
  }) as unknown as LeadFakeDb["db"];

async function text(body: string, phone = PHONE, key = PHONE_KEY) {
  sid += 1;
  const db = flaky(fake.db);
  const inbound: SharedLineInbound = { fromPhone: phone, phoneKey: key, body, messageSid: `SM${sid}`, mediaCount: 0 };
  const sess = await loadSharedLineSession(db, key);
  const result = await routeSharedLineInboundWithReply(db, inbound, sess, {
    dedicatedWorkspaceIds: SHARED.dedicatedWorkspaceIds,
    unknownSender: { lead: { now: () => NOW, listings, extract: async () => null, origin: () => "https://proplane.ai", paidNumberOf: async () => MARCUS_NUMBER, firstNameOf: async (id) => (id === OWNER_MARCUS ? "Marcus" : null) } },
    locked: { now: () => NOW, listings, paidNumberOf: async () => MARCUS_NUMBER, firstNameOf: async (id) => (id === OWNER_MARCUS ? "Marcus" : null) },
  });
  return result;
}

/** The phone's newest lead (the switch exchange opens a fresh one after the first was assigned). */
const lead = () => fake.rows.sms_unassigned_leads!.filter((l) => l.phone_key === PHONE_KEY).at(-1)!;
const session = () => fake.rows.sms_line_sessions?.find((s) => s.phone_key === PHONE_KEY);
const messagesFor = (ws: string) => mocks.messages.filter((m) => m.workspaceId === ws);

beforeEach(() => {
  mocks.messages.length = 0;
  mocks.alerts.length = 0;
  sid = 0;
  saveMode = "ok";
  catalog = [SVC_HOME, LENA_HOME, MARCUS_HOME, FAR(1, "managed", OWNER_SVC, WS_SVC), FAR(2, "free", OWNER_OTHER, WS_OTHER)];
  fake = seed();
});

async function lockedToLena() {
  for (const t of ["what houses are in seattle?", "under 1200", "dec 1 for 6 months", "near UW", "private, furnished"]) await text(t);
  await text("2");
  mocks.messages.length = 0;
  mocks.alerts.length = 0;
  expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt" });
}

describe.each(["error", "throw"] as const)("a lock save that %ss", (mode) => {
  it("assignLeadToHouse: no assignment, no acknowledgment, no new-owner rows, and the lead stays open", async () => {
    await text("what houses are in seattle?");
    const id = String(lead().id);
    saveMode = mode;
    const result = await assignLeadToHouse(flaky(fake.db), { leadId: id, propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(lead()).toMatchObject({ status: "open" });
    expect(lead().assigned_workspace_id ?? null).toBeNull();
    expect(mocks.messages).toEqual([]);
    expect(mocks.alerts).toEqual([]);
    expect(session()).toBeUndefined();
    // Once the database answers, the same assignment goes through.
    saveMode = "ok";
    expect(await assignLeadToHouse(flaky(fake.db), { leadId: id, propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW })).toMatchObject({ ok: true, workspaceId: WS_SVC });
    expect(session()).toMatchObject({ locked_property_id: "prop-4709a" });
  });

  it("an admin placement into a workspace fails the same way", async () => {
    await text("what houses are in seattle?");
    saveMode = mode;
    const result = await assignLeadToHouse(flaky(fake.db), { leadId: String(lead().id), workspaceId: WS_SVC, by: "admin" }, { now: () => NOW });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(lead()).toMatchObject({ status: "open" });
    expect(mocks.messages).toEqual([]);
  });

  it("the switch 'yes' to a free/managed home: no 'new home' acknowledgment, the OLD lock stays, nothing opens in the new workspace", async () => {
    await lockedToLena();
    const ask = await text("what about the other one?");
    expect(ask.unassignedReply).toBe("Which one? 1) 4709A 8th Ave NE, Room A 2) 12 Ravenna Pl, Room A");
    saveMode = mode;
    const yes = await text("1");
    expect(yes.unassignedReply).toBe(RETRY);
    expect(yes.unassignedReply).not.toMatch(/Eighth|4709A|rent|available/i);
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt", current_workspace_id: WS_LENA });
    expect(lead()).toMatchObject({ status: "open" });
    expect(messagesFor(WS_SVC)).toEqual([]);
    expect(mocks.messages).toEqual([]);
    expect(mocks.alerts).toEqual([]);
    // The next ordinary text still goes to the OLD locked owner (the lock was never half-moved)...
    saveMode = "ok";
    // ...and a retry of the yes works once the save does.
    const again = await text("1");
    expect(again.unassignedReply).toContain("4709A 8th Ave NE");
    expect(session()).toMatchObject({ locked_property_id: "prop-4709a", current_workspace_id: WS_SVC });
  });

  it("the switch 'yes' to a PAID manager's home (paidInterestTurn via relock): no number given, no interest row, old lock stays", async () => {
    await lockedToLena();
    await text("what about the other one?");
    saveMode = mode;
    const yes = await text("2");
    expect(yes.unassignedReply).toBe(RETRY);
    expect(yes.unassignedReply).not.toContain("Marcus");
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt", current_workspace_id: WS_LENA });
    expect(lead()).toMatchObject({ status: "open" });
    expect(lead().assigned_workspace_id ?? null).toBeNull();
    expect(messagesFor(WS_MARCUS)).toEqual([]);
    const turns = (fake.rows.sms_unassigned_lead_turns ?? []).filter((t) => t.direction === "outbound").map((t) => String(t.body));
    expect(turns.some((b) => b.includes("Marcus") || b.includes("555-0142"))).toBe(false);
  });

  it("a stranger naming a paid manager's home: retry line (with the first-reply notice), no lock, no interest rows, lead open", async () => {
    saveMode = mode;
    const out = await text("is 12 Ravenna Pl still available?");
    expect(out.unassignedReply).toBe(`Hi, this is PropLane. Reply STOP to opt out. ${RETRY}`);
    expect(out.unassignedReply).not.toContain("Marcus");
    expect(session()).toBeUndefined();
    expect(lead()).toMatchObject({ status: "open" });
    expect(mocks.messages).toEqual([]);
    // Once saves work, the next text gets the manager's number and the lock.
    saveMode = "ok";
    const next = await text("is 12 Ravenna Pl still available?");
    expect(next.unassignedReply).toContain("text Marcus at (206) 555-0142");
    expect(session()).toMatchObject({ locked_property_id: "prop-ravenna" });
  });

  it("a stranger naming a free manager's home: retry line, lead stays open, nothing routed to that workspace", async () => {
    saveMode = mode;
    const out = await text("Is the room at 5020 Roosevelt Way still open?");
    expect(out.decision.kind).not.toBe("routed");
    expect(out.unassignedReply).toContain(RETRY);
    expect(session()).toBeUndefined();
    expect(messagesFor(WS_LENA)).toEqual([]);
    expect(lead()).toMatchObject({ status: "open" });
  });
});
