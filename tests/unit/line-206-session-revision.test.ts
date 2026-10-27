// Finding: the lock write is a compare-and-swap on the COMPLETE prior session revision (workspace, role, lock, lock time and
// updated_at), and a rollback only ever undoes a row WE wrote (matched on the updated_at our write produced). After a known
// conflict (a 23505, or zero matched rows) we wrote nothing, so we never revert or delete anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { loadSharedLineSession, readSessionSnapshot, revertSharedLineRoute, saveSharedLineRoute, saveSharedLineRouteIf } from "@/lib/one-number/session.server";
import { claimLeadAndLock } from "@/lib/one-number/home-lock.server";
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


afterEach(() => {
  vi.useRealTimers();
});

const B_TIME = new Date("2026-10-26T20:00:07.000Z");
const isSessionWrite = (c: Ctx) => c.table === "sms_line_sessions" && c.op !== "select";
const aSessionWrites = () => sessionWrites().filter((w) => w.who === "A");
/** An ordinary router save (explicit entry code / routed text) by another request, seven seconds after A's `at`. */
async function ordinarySave(workspaceId: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(B_TIME);
  await saveSharedLineRoute(gated("B"), PHONE_KEY, { workspaceId, role: "prospect" });
  vi.useRealTimers();
}
const PRIOR_ROW = { phone_key: PHONE_KEY, current_workspace_id: WS_OTHER, active_role: "prospect", locked_property_id: null, locked_at: null, pending_candidates: null, pending_asked_at: null, updated_at: "2026-10-26T10:00:00.000Z" };

describe("(a) the snapshot said no session and an ordinary writer inserted one first", () => {
  it("assignLeadToHouse: A's insert hits 23505, B's session survives, A replies retry and its claim is rolled back", async () => {
    await openLead();
    const result = await assignLeadToHouse(
      gated("A", async (c) => { if (c.table === "sms_line_sessions" && c.op === "insert") await ordinarySave(WS_LENA); }),
      { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" },
      { now: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(fake.rows.sms_line_sessions).toHaveLength(1);
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, updated_at: B_TIME.toISOString() });
    expect(aSessionWrites().map((w) => w.op)).toEqual(["insert"]);
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null, assigned_property_id: null, assigned_at: null });
    expect(mocks.messages).toEqual([]);
    expect(mocks.alerts).toEqual([]);
  });

  it("paidInterestTurn: RETRY_REPLY, B's session intact, no delete", async () => {
    await openLead();
    const turn = await paidInterestTurn(
      gated("A", async (c) => { if (c.table === "sms_line_sessions" && c.op === "insert") await ordinarySave(WS_LENA); }),
      leadOf(),
      MARCUS_HOME,
      { inboundSid: "SM-x" },
      paidDeps,
    );
    expect(turn.reply).toBe(RETRY);
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, updated_at: B_TIME.toISOString() });
    expect(aSessionWrites().some((w) => w.op === "delete")).toBe(false);
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null });
    expect(outboundReplies().some((b) => b.includes("Marcus"))).toBe(false);
  });
});

describe("(b) the snapshot had a session and an ordinary router write changed it, leaving the lock alone", () => {
  it("assignLeadToHouse: the guarded write matches 0 rows, B's route survives, retry, claim rolled back, nothing restored over B", async () => {
    await openLead();
    fake.rows.sms_line_sessions = [{ ...PRIOR_ROW }];
    const result = await assignLeadToHouse(
      gated("A", async (c) => { if (c.table === "sms_line_sessions" && c.op === "update") await ordinarySave(WS_LENA); }),
      { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" },
      { now: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, locked_property_id: null, updated_at: B_TIME.toISOString() });
    // A tried exactly one session write (the guarded update); it did not run a restore after matching nothing.
    expect(aSessionWrites().map((w) => w.op)).toEqual(["update"]);
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null, assigned_at: null });
    expect(mocks.messages).toEqual([]);
  });

  it("the guard covers role and updated_at, not just the lock: each changed field alone defeats the write", async () => {
    const base = { ...PRIOR_ROW, locked_property_id: "prop-old", locked_at: "2026-10-26T09:00:00.000Z" };
    for (const change of [{ active_role: "resident" }, { updated_at: "2026-10-26T10:00:00.001Z" }, { current_workspace_id: WS_LENA }]) {
      fake = seed();
      fake.rows.sms_line_sessions = [{ ...base }];
      const prior = (await readSessionSnapshot(gated("A"), PHONE_KEY))!;
      Object.assign(fake.rows.sms_line_sessions[0]!, change);
      const res = await saveSharedLineRouteIf(gated("A"), PHONE_KEY, { workspaceId: WS_SVC, role: "prospect", lockedPropertyId: "prop-4709a" }, prior, NOW.toISOString());
      expect(res).toEqual({ kind: "conflict" });
      expect(session()).toMatchObject({ ...base, ...change });
    }
  });

  it("the snapshot carries updated_at verbatim (no Date round trip)", async () => {
    fake.rows.sms_line_sessions = [{ ...PRIOR_ROW, updated_at: "2026-10-26T10:00:00.123456+00:00" }];
    const prior = await readSessionSnapshot(gated("A"), PHONE_KEY);
    expect(prior).toMatchObject({ exists: true, updatedAt: "2026-10-26T10:00:00.123456+00:00" });
  });
});

describe("(c) rollback removes only what we wrote", () => {
  const at = NOW.toISOString();
  const route = { workspaceId: WS_SVC, role: "prospect" as const, lockedPropertyId: "prop-4709a" };

  it("insert path: our row is deleted when nothing newer touched it", async () => {
    const prior = (await readSessionSnapshot(gated("A"), PHONE_KEY))!;
    const saved = await saveSharedLineRouteIf(gated("A"), PHONE_KEY, route, prior, at);
    expect(saved).toEqual({ kind: "written", updatedAt: at });
    await revertSharedLineRoute(gated("A"), PHONE_KEY, { workspaceId: WS_SVC, lockedPropertyId: "prop-4709a", at, updatedAt: (saved as { updatedAt: string }).updatedAt }, prior);
    expect(session()).toBeUndefined();
  });

  it("insert path: a newer concurrent write, even with identical route and lock values, is left alone", async () => {
    const prior = (await readSessionSnapshot(gated("A"), PHONE_KEY))!;
    const saved = (await saveSharedLineRouteIf(gated("A"), PHONE_KEY, route, prior, at)) as { kind: "written"; updatedAt: string };
    await ordinarySave(WS_SVC);
    await revertSharedLineRoute(gated("A"), PHONE_KEY, { workspaceId: WS_SVC, lockedPropertyId: "prop-4709a", at, updatedAt: saved.updatedAt }, prior);
    expect(session()).toMatchObject({ current_workspace_id: WS_SVC, updated_at: B_TIME.toISOString() });
  });

  it("update path: our write is restored to the prior row; a newer concurrent write is left alone", async () => {
    fake.rows.sms_line_sessions = [{ ...PRIOR_ROW }];
    const prior = (await readSessionSnapshot(gated("A"), PHONE_KEY))!;
    const saved = (await saveSharedLineRouteIf(gated("A"), PHONE_KEY, route, prior, at)) as { kind: "written"; updatedAt: string };
    expect(session()).toMatchObject({ current_workspace_id: WS_SVC, locked_property_id: "prop-4709a", updated_at: at });
    const mine = { workspaceId: WS_SVC, lockedPropertyId: "prop-4709a", at, updatedAt: saved.updatedAt };
    await revertSharedLineRoute(gated("A"), PHONE_KEY, mine, prior);
    expect(session()).toMatchObject({ current_workspace_id: WS_OTHER, locked_property_id: null, locked_at: null });
    // Again, but this time B writes after ours.
    fake.rows.sms_line_sessions = [{ ...PRIOR_ROW }];
    await saveSharedLineRouteIf(gated("A"), PHONE_KEY, route, prior, at);
    await ordinarySave(WS_LENA);
    await revertSharedLineRoute(gated("A"), PHONE_KEY, mine, prior);
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, updated_at: B_TIME.toISOString() });
  });

  it("assignLeadToHouse: our insert applies then reports a failure, and a newer writer lands before the undo: their row stays, the claim rolls back", async () => {
    await openLead();
    const result = await assignLeadToHouse(
      gated("A", async (c) => {
        if (c.table === "sms_line_sessions" && c.op === "insert") return "applyThenThrow";
        if (c.table === "sms_line_sessions" && c.op === "delete") await ordinarySave(WS_LENA);
      }),
      { leadId: String(lead().id), propertyId: "prop-4709a", by: "prospect" },
      { now: () => NOW },
    );
    expect(result).toEqual({ ok: false, error: "unavailable" });
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, updated_at: B_TIME.toISOString() });
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null });
  });
});

describe("(d) an admin claim with no home (propertyId null), both orders", () => {
  const claim = (db: LeadFakeDb["db"]) =>
    claimLeadAndLock(db, { lead: leadOf(), target: { workspaceId: WS_SVC, propertyId: null }, at: NOW.toISOString(), assignedProfile: {} });

  it("their ordinary insert first: A conflicts, their session is not deleted, claim rolled back", async () => {
    await openLead();
    const res = await claim(gated("A", async (c) => { if (c.table === "sms_line_sessions" && c.op === "insert") await ordinarySave(WS_LENA); }));
    expect(res).toEqual({ kind: "unavailable" });
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, updated_at: B_TIME.toISOString() });
    expect(aSessionWrites().map((w) => w.op)).toEqual(["insert"]);
    expect(lead()).toMatchObject({ status: "open", assigned_workspace_id: null });
  });

  it("their ordinary write lands between A's snapshot and A's update: A conflicts, no restore, claim rolled back", async () => {
    await openLead();
    fake.rows.sms_line_sessions = [{ ...PRIOR_ROW }];
    const res = await claim(gated("A", async (c) => { if (c.table === "sms_line_sessions" && c.op === "update") await ordinarySave(WS_LENA); }));
    expect(res).toEqual({ kind: "unavailable" });
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, updated_at: B_TIME.toISOString() });
    expect(aSessionWrites().map((w) => w.op)).toEqual(["update"]);
    expect(lead()).toMatchObject({ status: "open" });
  });

  it("their write lands first, then A snapshots: A wins on the fresh revision", async () => {
    await openLead();
    await ordinarySave(WS_LENA);
    const res = await claim(gated("A"));
    expect(res).toEqual({ kind: "won" });
    expect(session()).toMatchObject({ current_workspace_id: WS_SVC, active_role: "prospect", locked_property_id: null, updated_at: NOW.toISOString() });
    expect(lead()).toMatchObject({ status: "assigned", assigned_workspace_id: WS_SVC, assigned_property_id: null });
  });

  it("A wins first, then their ordinary write: theirs lands on top (their write bumps updated_at), nothing of A's is rolled back", async () => {
    await openLead();
    expect(await claim(gated("A"))).toEqual({ kind: "won" });
    await ordinarySave(WS_LENA);
    expect(session()).toMatchObject({ current_workspace_id: WS_LENA, updated_at: B_TIME.toISOString() });
    expect(lead()).toMatchObject({ status: "assigned", assigned_workspace_id: WS_SVC });
  });
});

describe("(e) ordinary writers bump updated_at, so the lock path detects them", () => {
  it("saveSharedLineRoute, saveSharedLinePending and clearSharedLinePending each change updated_at", async () => {
    const { saveSharedLinePending, clearSharedLinePending } = await import("@/lib/one-number/session.server");
    fake.rows.sms_line_sessions = [{ ...PRIOR_ROW }];
    await saveSharedLineRoute(gated("B"), PHONE_KEY, { workspaceId: WS_LENA, role: "prospect" });
    const afterRoute = String(session()!.updated_at);
    expect(afterRoute).not.toBe(PRIOR_ROW.updated_at);
    fake.rows.sms_line_sessions = [{ ...PRIOR_ROW }];
    await saveSharedLinePending(gated("B"), PHONE_KEY, []);
    expect(session()!.updated_at).not.toBe(PRIOR_ROW.updated_at);
    fake.rows.sms_line_sessions = [{ ...PRIOR_ROW }];
    await clearSharedLinePending(gated("B"), PHONE_KEY);
    expect(session()!.updated_at).not.toBe(PRIOR_ROW.updated_at);
  });
});
