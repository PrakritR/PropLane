// Finding: claim and lock are ONE ordered, conditional unit (claim the lead first; the lock write is a compare-and-swap on
// the lock values read before the claim; the success reply is recorded only after both applied). Controlled interleavings below.
// (Prior finding, still held: the home lock must be PERSISTED before anything tells the prospect (or a workspace) the home is theirs. A failed
// (false) or thrown sms_line_sessions save leaves the previous lock and assignment untouched and sends a neutral retry line.)
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

import { assignLeadToHouse, paidInterestTurn } from "@/lib/one-number/unassigned-leads.server";
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
    { constraints: { ...LEAD_CONSTRAINTS, sms_line_sessions: (row, existing) => (existing.some((r) => r.phone_key === row.phone_key) ? "23505" : null) } },
  );
}


const RETRY = "I could not check rooms just now. Text me again in a minute and I will try again.";

type Ctx = { who: string; table: string; op: "select" | "insert" | "update" | "upsert" | "delete"; patch: Record<string, unknown> | undefined };
type Act = void | "fail" | "throw" | "applyThenThrow";
type Hook = (ctx: Ctx) => Promise<Act> | Act;

let fake: LeadFakeDb;
let sid = 0;
/** Every write the code under test attempted, by actor, in order. */
let writes: Ctx[] = [];

/** A db view whose every call passes through `hook`, which can pause it (await), fail it, or throw before/after it applies. */
function gated(who: string, hook: Hook = () => undefined): LeadFakeDb["db"] {
  const inner = fake.db as unknown as { from: (t: string) => Record<string, (...a: unknown[]) => unknown> };
  return {
    from(table: string) {
      const target = inner.from(table);
      let op: Ctx["op"] = "select";
      let patch: Ctx["patch"];
      const run = async (single?: "maybeSingle" | "single") => {
        const ctx: Ctx = { who, table, op, patch };
        if (op !== "select") writes.push(ctx);
        const act = await hook(ctx);
        if (act === "throw") throw new Error("connection reset");
        if (act === "fail") return { data: null, error: { code: "57014", message: "statement timeout" } };
        const res = single ? await (target[single] as () => Promise<unknown>)() : await new Promise((resolve, reject) => (target.then as (a: (v: unknown) => void, b: (e: unknown) => void) => void)(resolve, reject));
        if (act === "applyThenThrow") throw new Error("connection reset after commit");
        return res;
      };
      const proxy: unknown = new Proxy(target, {
        get(t, prop: string) {
          if (prop === "then") return (a: (v: unknown) => unknown, r?: (e: unknown) => unknown) => run().then(a, r);
          if (prop === "maybeSingle" || prop === "single") return () => run(prop);
          const value = t[prop];
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") {
              op = prop;
              patch = args[0] as Ctx["patch"];
            }
            value.apply(t, args);
            return proxy;
          };
        },
      });
      return proxy;
    },
  } as unknown as LeadFakeDb["db"];
}

async function text(body: string, messageSid?: string, db: LeadFakeDb["db"] = gated("router")) {
  sid += 1;
  const inbound: SharedLineInbound = { fromPhone: PHONE, phoneKey: PHONE_KEY, body, messageSid: messageSid ?? `SM${sid}`, mediaCount: 0 };
  const sess = await loadSharedLineSession(db, PHONE_KEY);
  return routeSharedLineInboundWithReply(db, inbound, sess, {
    dedicatedWorkspaceIds: SHARED.dedicatedWorkspaceIds,
    unknownSender: { lead: { now: () => NOW, listings, extract: async () => null, origin: () => "https://proplane.ai", paidNumberOf: async () => MARCUS_NUMBER, firstNameOf: async (id) => (id === OWNER_MARCUS ? "Marcus" : null) } },
    locked: { now: () => NOW, listings, paidNumberOf: async () => MARCUS_NUMBER, firstNameOf: async (id) => (id === OWNER_MARCUS ? "Marcus" : null) },
  });
}

const lead = () => fake.rows.sms_unassigned_leads!.filter((l) => l.phone_key === PHONE_KEY).at(-1)!;
const session = () => fake.rows.sms_line_sessions?.find((s) => s.phone_key === PHONE_KEY);
const sessionWrites = () => writes.filter((w) => w.table === "sms_line_sessions");
const outboundReplies = () => (fake.rows.sms_unassigned_lead_turns ?? []).filter((t) => t.direction === "outbound").map((t) => String(t.body));
const paidDeps = { now: () => NOW, paidNumberOf: async () => MARCUS_NUMBER, firstNameOf: async () => "Marcus" };
const leadOf = () => ({ id: String(lead().id), phoneKey: PHONE_KEY, profile: (lead().profile ?? {}) as never });

/** A gate: `wait()` blocks until `open()` is called. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  return { open, arrive, arrived, wait: async () => { arrive(); await opened; } };
}
const isClaim = (c: Ctx) => c.table === "sms_unassigned_leads" && c.op === "update" && c.patch?.status === "assigned";

beforeEach(() => {
  mocks.messages.length = 0;
  mocks.alerts.length = 0;
  sid = 0;
  writes = [];
  catalog = [SVC_HOME, LENA_HOME, MARCUS_HOME, FAR(1, "managed", OWNER_SVC, WS_SVC), FAR(2, "free", OWNER_OTHER, WS_OTHER)];
  fake = seed();
});

async function openLead() {
  await text("what houses are in seattle?");
  writes = [];
  mocks.messages.length = 0;
  expect(lead()).toMatchObject({ status: "open" });
}

describe("(a) two requests race for the same lead", () => {
  it("both read the session, A wins the claim and pauses before its lock write, B runs to the end: one lock, equal to the claim winner", async () => {
    await openLead();
    const bothClaiming = [gate(), gate()];
    const aLock = gate();
    const a = assignLeadToHouse(
      gated("A", async (c) => {
        if (isClaim(c)) { await bothClaiming[0]!.wait(); await bothClaiming[1]!.arrived; }
        if (c.table === "sms_line_sessions" && c.op !== "select") await aLock.wait();
      }),
      { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" },
      { now: () => NOW },
    );
    // A is released into its claim first; B (which already read the same empty session) claims after A.
    await bothClaiming[0]!.arrived;
    const b = assignLeadToHouse(
      gated("B", async (c) => { if (isClaim(c)) { bothClaiming[1]!.arrive(); await bothClaiming[0]!.arrived; } }),
      { leadId: String(lead().id), propertyId: "prop-roosevelt", by: "prospect" },
      { now: () => NOW },
    );
    bothClaiming[0]!.open();
    await aLock.arrived;
    // A holds the claim but has not locked yet; B's whole request runs now and must lose without touching the lock.
    expect(await b).toEqual({ ok: false, error: "unavailable" });
    expect(session()).toBeUndefined();
    aLock.open();
    expect(await a).toMatchObject({ ok: true, workspaceId: WS_SVC });
    expect(fake.rows.sms_line_sessions).toHaveLength(1);
    expect(session()).toMatchObject({ locked_property_id: "prop-4709a", current_workspace_id: WS_SVC });
    expect(lead()).toMatchObject({ status: "assigned", assigned_workspace_id: WS_SVC, assigned_property_id: "prop-4709a" });
    expect(sessionWrites().map((w) => w.who)).toEqual(["A"]);
    expect(mocks.messages.every((m) => m.workspaceId === WS_SVC)).toBe(true);
    expect(mocks.alerts).toHaveLength(1);
  });

  it("the reverse order (B claims first) stores B's lock, never A's", async () => {
    await openLead();
    const aClaim = gate();
    const a = assignLeadToHouse(gated("A", async (c) => { if (isClaim(c)) await aClaim.wait(); }), { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW });
    await aClaim.arrived;
    expect(await assignLeadToHouse(gated("B"), { leadId: String(lead().id), propertyId: "prop-roosevelt", by: "prospect" }, { now: () => NOW })).toMatchObject({ ok: true, workspaceId: WS_LENA });
    aClaim.open();
    expect(await a).toEqual({ ok: false, error: "unavailable" });
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt", current_workspace_id: WS_LENA });
    expect(lead()).toMatchObject({ assigned_workspace_id: WS_LENA });
    expect(sessionWrites().map((w) => w.who)).toEqual(["B"]);
  });

  it("a duplicate arriving in the winner's gap (claimed, lock not landed) is rejected and writes no lock", async () => {
    await openLead();
    const id = String(lead().id);
    const aLock = gate();
    const a = assignLeadToHouse(gated("A", async (c) => { if (c.table === "sms_line_sessions" && c.op !== "select") await aLock.wait(); }), { leadId: id, propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW });
    await aLock.arrived;
    expect(await assignLeadToHouse(gated("dup"), { leadId: id, propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW })).toEqual({ ok: false, error: "lead_not_open" });
    aLock.open();
    await a;
    // The lead is no longer open, so a later duplicate is rejected at the read; the lock is still A's alone.
    expect(session()).toMatchObject({ locked_property_id: "prop-4709a" });
    expect(sessionWrites()).toHaveLength(1);
  });
});

describe("(b) a claim that matches no row", () => {
  it("assignLeadToHouse: no lock write, no acknowledgment rows, no alert, retry", async () => {
    await openLead();
    const result = await assignLeadToHouse(
      gated("A", (c) => {
        // Someone else takes the lead between the read and the claim.
        if (isClaim(c)) Object.assign(lead(), { status: "assigned", assigned_workspace_id: WS_LENA, assigned_property_id: "prop-roosevelt" });
      }),
      { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" },
      { now: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(sessionWrites()).toEqual([]);
    expect(session()).toBeUndefined();
    expect(mocks.messages).toEqual([]);
    expect(mocks.alerts).toEqual([]);
  });

  it("paidInterestTurn: retry reply, no lock write, no success reply recorded, no interest rows", async () => {
    await openLead();
    const turn = await paidInterestTurn(
      gated("A", (c) => { if (isClaim(c)) Object.assign(lead(), { status: "assigned", assigned_workspace_id: WS_LENA, assigned_property_id: "prop-roosevelt" }); }),
      leadOf(),
      MARCUS_HOME,
      { inboundSid: "SM-x" },
      paidDeps,
    );
    expect(turn.reply).toBe(RETRY);
    expect(sessionWrites()).toEqual([]);
    expect(session()).toBeUndefined();
    expect(outboundReplies().some((b) => b.includes("Marcus"))).toBe(false);
    expect(mocks.messages).toEqual([]);
  });

  it("paidInterestTurn: the winner already holds exactly this home and lock -> the same answer, nothing more written", async () => {
    await openLead();
    const id = String(lead().id);
    expect((await paidInterestTurn(gated("A"), leadOf(), MARCUS_HOME, { inboundSid: "SM-1" }, paidDeps)).reply).toContain("text Marcus at (206) 555-0142");
    const before = mocks.messages.length;
    writes = [];
    // A second request that read the lead as open (stale) and now loses the claim to the stored, matching assignment.
    const dup = await paidInterestTurn(gated("dup", (c) => { if (c.table === "sms_unassigned_leads" && c.op === "update") Object.assign(lead(), { status: "assigned" }); }), { id, phoneKey: PHONE_KEY, profile: {} as never }, MARCUS_HOME, { inboundSid: "SM-2" }, paidDeps);
    expect(dup.reply).toContain("text Marcus at (206) 555-0142");
    expect(sessionWrites()).toEqual([]);
    expect(mocks.messages).toHaveLength(before);
  });
});

describe("(c) a claim that errors or throws", () => {
  it.each(["fail", "throw"] as const)("assignLeadToHouse (%s): retry, nothing written, lead open, no session", async (act) => {
    await openLead();
    const result = await assignLeadToHouse(gated("A", (c) => (isClaim(c) ? act : undefined)), { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(lead()).toMatchObject({ status: "open" });
    expect(sessionWrites()).toEqual([]);
    expect(session()).toBeUndefined();
    expect(mocks.messages).toEqual([]);
    expect(mocks.alerts).toEqual([]);
  });

  it.each(["fail", "throw"] as const)("paidInterestTurn (%s): RETRY_REPLY, no lock, no success reply, no interest rows", async (act) => {
    await openLead();
    const turn = await paidInterestTurn(gated("A", (c) => (isClaim(c) ? act : undefined)), leadOf(), MARCUS_HOME, { inboundSid: "SM-x" }, paidDeps);
    expect(turn.reply).toBe(RETRY);
    expect(lead()).toMatchObject({ status: "open" });
    expect(sessionWrites()).toEqual([]);
    expect(outboundReplies().some((b) => b.includes("Marcus"))).toBe(false);
    expect(mocks.messages).toEqual([]);
  });

  it("a claim that APPLIED and then reported a thrown error is undone (exact values only)", async () => {
    await openLead();
    const result = await assignLeadToHouse(gated("A", (c) => (isClaim(c) ? "applyThenThrow" : undefined)), { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null, assigned_property_id: null, assigned_at: null });
    expect(sessionWrites()).toEqual([]);
  });
});

describe("(d) the lock compare-and-swap matches no row after a won claim", () => {
  it("prior session MISSING and another writer inserted one first: claim rolled back, their lock untouched, retry", async () => {
    await openLead();
    const theirs = { phone_key: PHONE_KEY, current_workspace_id: WS_LENA, active_role: "prospect", locked_property_id: "prop-roosevelt", locked_at: "2026-10-26T19:59:00.000Z" };
    const result = await assignLeadToHouse(
      gated("A", (c) => { if (c.table === "sms_line_sessions" && c.op === "insert") fake.rows.sms_line_sessions = [{ ...theirs }]; }),
      { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" },
      { now: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null, assigned_property_id: null, assigned_at: null });
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt", current_workspace_id: WS_LENA });
    expect(mocks.messages).toEqual([]);
    expect(mocks.alerts).toEqual([]);
  });

  it("prior session HAD a lock and it moved under us: claim rolled back, the newer lock stays", async () => {
    await openLead();
    fake.rows.sms_line_sessions = [{ phone_key: PHONE_KEY, current_workspace_id: WS_OTHER, active_role: "prospect", locked_property_id: "prop-old", locked_at: "2026-10-26T10:00:00.000Z" }];
    const result = await assignLeadToHouse(
      gated("A", (c) => { if (c.table === "sms_line_sessions" && c.op === "update") Object.assign(session()!, { current_workspace_id: WS_LENA, locked_property_id: "prop-roosevelt", locked_at: "2026-10-26T19:59:00.000Z" }); }),
      { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" },
      { now: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null });
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt", current_workspace_id: WS_LENA });
  });

  it("paidInterestTurn: claim rolled back, RETRY_REPLY, no success reply, no interest rows", async () => {
    await openLead();
    const turn = await paidInterestTurn(
      gated("A", (c) => { if (c.table === "sms_line_sessions" && c.op === "insert") fake.rows.sms_line_sessions = [{ phone_key: PHONE_KEY, current_workspace_id: WS_LENA, active_role: "prospect", locked_property_id: "prop-roosevelt", locked_at: "2026-10-26T19:59:00.000Z" }]; }),
      leadOf(),
      MARCUS_HOME,
      { inboundSid: "SM-x" },
      paidDeps,
    );
    expect(turn.reply).toBe(RETRY);
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null });
    expect(outboundReplies().some((b) => b.includes("Marcus"))).toBe(false);
    expect(mocks.messages).toEqual([]);
  });
});

describe("(e) rollback and unreadable prior state", () => {
  it("prior session missing, the lock write APPLIES then reports a failure: the rollback removes the lock (no session left)", async () => {
    await openLead();
    const result = await assignLeadToHouse(gated("A", (c) => (c.table === "sms_line_sessions" && c.op === "insert" ? "applyThenThrow" : undefined)), { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(session()).toBeUndefined();
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null });
    expect(mocks.messages).toEqual([]);
  });

  it("prior session existed, the lock write applies then reports a failure: route, lock and pending question are restored exactly", async () => {
    await openLead();
    const prior = { phone_key: PHONE_KEY, current_workspace_id: WS_LENA, active_role: "prospect", locked_property_id: "prop-roosevelt", locked_at: "2026-10-26T10:00:00.000Z", pending_candidates: [{ workspaceId: WS_SVC, ownerUserId: OWNER_SVC, role: "prospect", reason: "x", propertyId: "prop-4709a", label: "A" }], pending_asked_at: "2026-10-26T19:00:00.000Z" };
    fake.rows.sms_line_sessions = [{ ...prior }];
    const result = await assignLeadToHouse(gated("A", (c) => (c.table === "sms_line_sessions" && c.op === "update" && c.patch?.locked_property_id === "prop-4709a" ? "applyThenThrow" : undefined)), { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, locked_property_id: "prop-roosevelt", locked_at: "2026-10-26T10:00:00.000Z", pending_candidates: prior.pending_candidates, pending_asked_at: prior.pending_asked_at });
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null });
  });

  it.each(["fail", "throw"] as const)("prior session UNREADABLE (%s): retry before ANY write", async (act) => {
    await openLead();
    const result = await assignLeadToHouse(gated("A", (c) => (c.table === "sms_line_sessions" && c.op === "select" ? act : undefined)), { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" }, { now: () => NOW });
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(writes).toEqual([]);
    expect(lead()).toMatchObject({ status: "open" });
    const turn = await paidInterestTurn(gated("P", (c) => (c.table === "sms_line_sessions" && c.op === "select" ? act : undefined)), leadOf(), MARCUS_HOME, { inboundSid: "SM-x" }, paidDeps);
    expect(turn.reply).toBe(RETRY);
    expect(writes.filter((w) => w.who === "P" && w.table !== "sms_unassigned_lead_turns")).toEqual([]);
    expect(outboundReplies().some((b) => b.includes("Marcus"))).toBe(false);
    expect(mocks.messages).toEqual([]);
  });
});

describe("(f) a replay of the same MessageSid after a failed attempt", () => {
  it.each(["fail", "throw"] as const)("never surfaces a success reply (lock write %s)", async (act) => {
    const failSessionWrites = (c: Ctx) => (c.table === "sms_line_sessions" && c.op !== "select" ? act : undefined);
    const first = await text("is 12 Ravenna Pl still available?", "SM-RETRY", gated("router", failSessionWrites));
    expect(first.unassignedReply).toBe(`Hi, this is PropLane. Reply STOP to opt out. ${RETRY}`);
    expect(lead()).toMatchObject({ status: "open" });
    expect(session()).toBeUndefined();
    // Twilio redelivers the same MessageSid, now with a healthy database: the stored answer is the retry line, not a success.
    const replay = await text("is 12 Ravenna Pl still available?", "SM-RETRY");
    expect(String(replay.unassignedReply ?? "")).not.toContain("Marcus");
    expect(String(replay.unassignedReply ?? "")).not.toContain("555-0142");
    expect(session()).toBeUndefined();
    expect(lead()).toMatchObject({ status: "open" });
    expect(mocks.messages).toEqual([]);
    // A genuinely new text (new MessageSid) succeeds.
    const next = await text("is 12 Ravenna Pl still available?");
    expect(next.unassignedReply).toContain("text Marcus at (206) 555-0142");
    expect(session()).toMatchObject({ locked_property_id: "prop-ravenna" });
  });
});
