// The 206 end to end over an in-memory database: a stranger's Seattle search, the lock to one home and its manager, the
// "Are you asking about X?" switch question, the paid manager's number on interest. Every text is routed through
// `routeSharedLineInboundWithReply` and, after each one, the test asserts WHICH workspaces' Communication got new message
// rows - the plan's "Where this text appears" table - and that the other inboxes' counts did not move.
import { mkdirSync, writeFileSync } from "node:fs";
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

let fake: LeadFakeDb;
let sid = 0;

/**
 * The conversation as the prospect and the managers live it, recorded for a reviewer (EVIDENCE_DIR only):
 * each text to the 206, what the line texted back, and whose Communication the turn landed in.
 */
const transcript: string[] = [];
const WORKSPACE_NAMES: Record<string, string> = {
  [WS_SVC]: "PropLane homes (PropLane-managed)",
  [WS_LENA]: "Lena Rentals (free plan)",
  [WS_MARCUS]: "Marcus Homes (paid number)",
  [WS_OTHER]: "Other Co",
};

function writeTranscript(name: string, title: string) {
  const out = process.env.EVIDENCE_DIR ?? "";
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/${name}.txt`, `${title}\n${"=".repeat(title.length)}\n\n${transcript.join("\n")}\n`, "utf8");
}

const counts = () => {
  const out: Record<string, number> = {};
  for (const m of mocks.messages) out[m.workspaceId] = (out[m.workspaceId] ?? 0) + 1;
  return out;
};

type Step = { result: SharedLineRouteResult; reply: string | null; rows: Record<string, string[]>; workspaces: string[] };

/** One text to the 206 through the router (what the seam does), then what the leasing pipeline would log for a routed text. */
async function text(body: string, phone = PHONE, key = PHONE_KEY): Promise<Step> {
  const before = mocks.messages.length;
  sid += 1;
  const inbound: SharedLineInbound = { fromPhone: phone, phoneKey: key, body, messageSid: `SM${sid}`, mediaCount: 0 };
  const session = await loadSharedLineSession(fake.db, key);
  const result = await routeSharedLineInboundWithReply(fake.db, inbound, session, {
    dedicatedWorkspaceIds: SHARED.dedicatedWorkspaceIds,
    unknownSender: { lead: { now: () => NOW, listings, extract: async () => null, origin: () => "https://proplane.ai", paidNumberOf: async () => MARCUS_NUMBER, firstNameOf: async (id) => (id === OWNER_MARCUS ? "Marcus" : null) } },
    locked: { now: () => NOW, listings, paidNumberOf: async () => MARCUS_NUMBER, firstNameOf: async (id) => (id === OWNER_MARCUS ? "Marcus" : null) },
  });
  // A routed text continues into that workspace's own pipeline, which logs it (the seam's "continue").
  if (result.decision.kind === "routed") mocks.messages.push({ workspaceId: result.decision.workspaceId, direction: "inbound", body, messageSid: `pipeline:${sid}` });
  const fresh = mocks.messages.slice(before);
  const rows: Record<string, string[]> = {};
  for (const m of fresh) (rows[m.workspaceId] ??= []).push(m.body);

  transcript.push(`prospect ${phone} -> 206: ${body}`);
  for (const line of (result.unassignedReply ?? "").split("\n").filter(Boolean)) transcript.push(`206 -> prospect:  ${line}`);
  const landed = Object.keys(rows);
  transcript.push(
    landed.length === 0
      ? "   lands in: nobody's Communication (Admin > Unassigned only)"
      : landed.map((id) => `   lands in: ${WORKSPACE_NAMES[id] ?? id} -> ${rows[id]!.map((r) => JSON.stringify(r)).join(", ")}`).join("\n"),
  );
  const locked = fake.rows.sms_line_sessions?.find((row) => row.phone_key === key)?.locked_property_id;
  transcript.push(`   phone is locked to: ${locked ?? "nothing yet"}`);
  transcript.push("");

  return { result, reply: result.unassignedReply, rows, workspaces: Object.keys(rows) };
}

const lead = () => fake.rows.sms_unassigned_leads!.find((l) => l.phone_key === PHONE_KEY)!;
const leadTurns = (leadId: string) => (fake.rows.sms_unassigned_lead_turns ?? []).filter((t) => t.lead_id === leadId).map((t) => `${t.direction}: ${t.body}`);
const session = () => fake.rows.sms_line_sessions!.find((s) => s.phone_key === PHONE_KEY)!;

beforeEach(() => {
  transcript.length = 0;
  mocks.messages.length = 0;
  mocks.alerts.length = 0;
  sid = 0;
  catalog = [SVC_HOME, LENA_HOME, MARCUS_HOME, FAR(1, "managed", OWNER_SVC, WS_SVC), FAR(2, "free", OWNER_OTHER, WS_OTHER)];
  fake = seed();
});

/** The plan's A5 conversation up to the offers. Nothing here reaches any workspace. */
async function toOffers() {
  const steps = [await text("what houses are in seattle?"), await text("under 1200"), await text("dec 1 for 6 months"), await text("near UW"), await text("private, furnished")];
  return steps;
}

describe("naming two homes asks which one", () => {
  it("a stranger naming 4709A and 12 Ravenna Pl gets 'Which one? 1) ... 2) ...' and nothing is locked or routed", async () => {
    const step = await text("what about 4709A and 12 Ravenna Pl");
    expect(step.reply).toMatch(/^Which one\? 1\) .*4709A.* 2\) .*12 Ravenna Pl/);
    expect(step.workspaces).toEqual([]);
    expect(mocks.messages).toEqual([]);
  });

  it("a phone locked to 4709A that names both homes is asked which one, not only about the other", async () => {
    await text("tell me about 4709A 8th Ave NE");
    expect(session()).toMatchObject({ locked_property_id: "prop-4709a" });
    const step = await text("what about 4709A and 12 Ravenna Pl");
    expect(step.reply).toMatch(/^Which one\? 1\) .*4709A.* 2\) .*12 Ravenna Pl/);
    expect(session()).toMatchObject({ locked_property_id: "prop-4709a" });
  });
});

describe("A5 · the Seattle conversation, step by step", () => {
  it("browsing: five texts narrow the search, each answered on the line, none in any Communication", async () => {
    const [first, budget, dates, area, offered] = await toOffers();
    expect(first.reply).toContain("What is your monthly budget for rent?");
    expect(budget.reply).toBe("When do you want to move in, and for how many months?");
    expect(dates.reply).toContain("Which area");
    expect(area.reply).toContain("private or shared bath");
    for (const step of [first, budget, dates, area, offered]) {
      expect(step.workspaces).toEqual([]);
      expect(step.result.decision).toMatchObject({ kind: "unassigned" });
    }
    expect(mocks.messages).toEqual([]);
    // Pre-lock browsing stays in Admin > Unassigned, read-only.
    expect(lead()).toMatchObject({ status: "open" });
    expect(leadTurns(String(lead().id)).length).toBe(10);
  });

  it("offers one PropLane-managed, one free-manager and one paid-manager home, cheapest first, with no phone number", async () => {
    const steps = await toOffers();
    const offered = steps[4]!;
    expect(offered.workspaces).toEqual([]);
    const reply = offered.reply!;
    expect(reply).toContain("These rooms fit:");
    const lines = reply.split("\n").filter((l) => /^\d\)/.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("4709A 8th Ave NE");
    expect(lines[1]).toContain("5020 Roosevelt Way NE");
    expect(lines[2]).toContain("12 Ravenna Pl");
    const offers = (lead().profile as { offers: Array<{ tier: string }> }).offers;
    expect(offers.map((o) => o.tier)).toEqual(["managed", "free", "paid"]);
    // No phone number in any offer bubble or in the joined text, whatever the format.
    const bubbles = offered.result.unassignedBubbles ?? [];
    expect(bubbles.length).toBeGreaterThan(1);
    for (const body of [reply, ...bubbles.map((b) => b.body)]) {
      expect(body).not.toMatch(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      expect(body).not.toContain(MARCUS_NUMBER.slice(2));
      expect(body).not.toMatch(/\+\d{7,}/);
    }
  });

  it("replays the whole conversation: each text lands exactly where the plan says and the other inboxes do not move", async () => {
    await toOffers();

    // 6. "tell me more about 2": first lock. Lena gets a Looking-for line, then the pick text through her own pipeline.
    const pick = await text("tell me more about 2");
    expect(pick.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_LENA, role: "prospect" });
    expect(pick.workspaces).toEqual([WS_LENA]);
    expect(pick.rows[WS_LENA]).toEqual(["Looking for: private room near UW · under $1200 · Dec 1 · 6 mo", "tell me more about 2"]);
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt", current_workspace_id: WS_LENA });
    expect(lead()).toMatchObject({ status: "assigned", assigned_workspace_id: WS_LENA });
    // The thread is stamped with the home, so only the owner and the co-hosts who hold it see it.
    expect(fake.rows.manager_sms_conversation_houses).toEqual([expect.objectContaining({ manager_user_id: OWNER_LENA, property_id: "prop-roosevelt" })]);
    // None of the browsing (the other managers' homes) reached Lena.
    expect(mocks.messages.some((m) => m.body.includes("These rooms fit") || m.body.includes("Ravenna") || m.body.includes("4709A"))).toBe(false);

    // 7. Still about her home: Lena only.
    const parking = await text("is parking included?");
    expect(parking.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_LENA });
    expect(parking.workspaces).toEqual([WS_LENA]);

    // 8. A different home is named by position: asked, not acted on. Nobody's Communication; the old lock holds.
    const before = counts();
    const ask = await text("actually im interested in 3");
    expect(ask.reply).toBe("Are you asking about 12 Ravenna Pl, Room A?");
    expect(ask.workspaces).toEqual([]);
    expect(counts()).toEqual(before);
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt" });
    const switchLead = fake.rows.sms_unassigned_leads!.find((l) => l.status === "open")!;
    expect(leadTurns(String(switchLead.id))).toEqual(["inbound: actually im interested in 3", "outbound: Are you asking about 12 Ravenna Pl, Room A?"]);

    // 9. "yes": the paid manager's number, and ONLY the interest + this reply in Marcus's Communication.
    const yes = await text("yes");
    expect(yes.reply).toBe("12 Ravenna Pl is listed by Marcus. To learn more or book a tour, text Marcus at (206) 555-0142.");
    expect(yes.workspaces).toEqual([WS_MARCUS]);
    expect(yes.rows[WS_MARCUS]).toEqual(["I'm interested in 12 Ravenna Pl.", yes.reply]);
    expect(session()).toMatchObject({ locked_property_id: "prop-ravenna" });
    expect(fake.rows.manager_sms_conversation_houses).toContainEqual(expect.objectContaining({ manager_user_id: OWNER_MARCUS, property_id: "prop-ravenna" }));
    // The number appears only now.
    expect(mocks.messages.filter((m) => m.body.includes("555-0142")).map((m) => m.workspaceId)).toEqual([WS_MARCUS]);

    // 10. "the first one, 4709A": asked again, nobody's Communication.
    const before2 = counts();
    const ask2 = await text("can i tour the first one, 4709A?");
    expect(ask2.reply).toBe("Are you asking about 4709A 8th Ave NE, Room A?");
    expect(ask2.workspaces).toEqual([]);
    expect(counts()).toEqual(before2);
    expect(session()).toMatchObject({ locked_property_id: "prop-ravenna" });

    // 11. "yes": re-lock to the PropLane-managed home. Only the PropLane workspace gets rows: Looking-for, then the details.
    const yes2 = await text("yes");
    expect(yes2.workspaces).toEqual([WS_SVC]);
    expect(yes2.rows[WS_SVC]).toHaveLength(2);
    expect(yes2.rows[WS_SVC]![0]).toBe("Looking for: private room near UW · under $1200 · Dec 1 · 6 mo");
    expect(yes2.rows[WS_SVC]![1]).toContain("4709A 8th Ave NE, Room A");
    expect(yes2.reply).toBe(yes2.rows[WS_SVC]![1]);
    expect(yes2.reply).not.toMatch(/\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/);
    expect(session()).toMatchObject({ locked_property_id: "prop-4709a", current_workspace_id: WS_SVC });

    // 12. Locked to the managed home: the next text is that workspace's.
    const sat = await text("sat 11");
    expect(sat.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_SVC });
    expect(sat.workspaces).toEqual([WS_SVC]);

    // Totals: Lena 3 (Looking-for, pick, parking), Marcus 2, PropLane 3 (Looking-for, details, sat 11). No one else, ever.
    expect(counts()).toEqual({ [WS_LENA]: 3, [WS_MARCUS]: 2, [WS_SVC]: 3 });
    writeTranscript(
      "50-line-206-conversation",
      "PropLane line (206) - one stranger's whole conversation: browsing, the tiered offers, the home lock, the switch question, and the paid manager's number",
    );
    // The switch lead's two questions and both answers lived in Unassigned only.
    expect(mocks.messages.some((m) => m.body === "yes")).toBe(false);
  });
});

describe("the switch question", () => {
  async function lockedToLena() {
    await toOffers();
    await text("2");
    mocks.messages.length = 0;
  }

  it("'no' keeps the old lock and says so; nothing reaches any workspace", async () => {
    await lockedToLena();
    await text("interested in 3");
    const no = await text("no");
    expect(no.reply).toBe("OK, still talking about 5020 Roosevelt Way NE.");
    expect(no.workspaces).toEqual([]);
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt", pending_candidates: null });
    // Back in Lena's chat.
    const next = await text("what is the deposit?");
    expect(next.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_LENA });
    expect(next.workspaces).toEqual([WS_LENA]);
  });

  it("'the other one' with three offers on record asks which, with the list; a number then answers it", async () => {
    await lockedToLena();
    const ask = await text("what about the other one?");
    expect(ask.reply).toBe("Which one? 1) 4709A 8th Ave NE, Room A 2) 12 Ravenna Pl, Room A");
    expect(ask.workspaces).toEqual([]);
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt" });
    const answer = await text("2");
    expect(answer.reply).toContain("12 Ravenna Pl is listed by Marcus");
    expect(answer.workspaces).toEqual([WS_MARCUS]);
    expect(session()).toMatchObject({ locked_property_id: "prop-ravenna" });
  });

  it("a text naming two other homes asks which", async () => {
    await lockedToLena();
    const ask = await text("compare 4709A 8th Ave and 12 Ravenna Pl for me");
    expect(ask.reply).toMatch(/^Which one\? 1\) .* 2\) /);
    expect(ask.workspaces).toEqual([]);
  });

  it("an ordinary question that happens to say 'second' is not a switch", async () => {
    await lockedToLena();
    const turn = await text("is the second bedroom furnished?");
    expect(turn.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_LENA });
  });

  it("naming the locked home again is not a switch", async () => {
    await lockedToLena();
    const turn = await text("is 5020 Roosevelt Way still open?");
    expect(turn.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_LENA });
  });

  it("an unrelated text ignores the question: it lapses and the text goes to the locked home", async () => {
    await lockedToLena();
    await text("interested in 3");
    const turn = await text("what is the rent again?");
    expect(turn.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_LENA });
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt", pending_candidates: null });
  });
});

describe("A2 · a stranger who names nothing specific", () => {
  it("'hi' gets one 'which home' reply and waits in Admin > Unassigned, in no Communication", async () => {
    const hi = await text("hi");
    expect(hi.reply).toBe("Hi! This is PropLane. Which home are you texting about? (street or house name)");
    expect(hi.workspaces).toEqual([]);
    expect(mocks.messages).toEqual([]);
    expect(lead()).toMatchObject({ status: "open", profile: expect.objectContaining({ stage: "hold" }) });
    expect(leadTurns(String(lead().id))).toEqual(["inbound: hi", "outbound: Hi! This is PropLane. Which home are you texting about? (street or house name)"]);
  });

  it("the next text naming a home locks the line to it; the hold stays out of the manager's inbox", async () => {
    await text("who is this?");
    const named = await text("Is the room at 5020 Roosevelt Way still open?");
    expect(named.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_LENA });
    expect(named.rows[WS_LENA]).toEqual(["Is the room at 5020 Roosevelt Way still open?"]);
    expect(session()).toMatchObject({ locked_property_id: "prop-roosevelt" });
  });

  it("a stranger naming a PropLane-managed home goes to the PropLane workspace with the home stamped", async () => {
    const named = await text("Is the room at 4709A 8th Ave still open?");
    expect(named.result.decision).toMatchObject({ kind: "routed", workspaceId: WS_SVC });
    expect(fake.rows.manager_sms_conversation_houses).toEqual([expect.objectContaining({ property_id: "prop-4709a" })]);
  });

  it("a stranger naming a paid manager's home is given that manager's number and nothing else lands anywhere else", async () => {
    const named = await text("is 12 Ravenna Pl still available?");
    const reply = "12 Ravenna Pl is listed by Marcus. To learn more or book a tour, text Marcus at (206) 555-0142.";
    // The very first reply on the line carries the business name and the STOP notice in front.
    expect(named.reply).toBe(`Hi, this is PropLane. Reply STOP to opt out. ${reply}`);
    expect(named.workspaces).toEqual([WS_MARCUS]);
    expect(named.rows[WS_MARCUS]).toEqual(["I'm interested in 12 Ravenna Pl.", reply]);
    // Asking again does not write again.
    const again = await text("thanks, any parking?");
    expect(again.reply).toBe(reply);
    expect(again.workspaces).toEqual([]);
  });

  it("a paid manager whose number cannot be named is not described and the line does not lock", async () => {
    const out = await routeSharedLineInboundWithReply(fake.db, { fromPhone: PHONE, phoneKey: PHONE_KEY, body: "is 12 Ravenna Pl still available?", messageSid: "SMX", mediaCount: 0 }, null, {
      dedicatedWorkspaceIds: SHARED.dedicatedWorkspaceIds,
      unknownSender: { lead: { now: () => NOW, listings, extract: async () => null, origin: () => "https://proplane.ai", paidNumberOf: async () => null, firstNameOf: async () => null } },
    });
    expect(out.unassignedReply).toMatch(/^I can only help with homes PropLane manages\./);
    expect(out.unassignedReply).not.toContain("Ravenna");
    expect(mocks.messages).toEqual([]);
    expect(fake.rows.sms_line_sessions ?? []).toEqual([]);
  });

  it("a second phone is untouched by the first one's lock", async () => {
    await toOffers();
    await text("2");
    const other = await text("hi", "+12065550188", "2065550188");
    expect(other.reply).toContain("Which home are you texting about?");
    expect(other.workspaces).toEqual([]);
  });
});

describe("the qualifier keeps asking while more than 4 rooms fit", () => {
  const many = () => [SVC_HOME, LENA_HOME, MARCUS_HOME, ...[1, 2, 3, 4, 5].map((n) => home(`prop-uw-${n}`, "free", `owner-${n}`, `ws-${n}`, { rent: 1000 + n, street: `${200 + n} 15th Ave NE`, name: `Fifteenth ${n} House` }))];

  it("asks the headcount while 8 rooms fit, and offers 3 (one per tier) without it", async () => {
    catalog = many();
    for (const body of ["what houses are in seattle?", "under 1200", "dec 1 for 6 months", "near UW"]) await text(body);
    const room = await text("private, furnished");
    expect(room.reply).toBe("How many people will be moving in?");
    const offered = await text("just me");
    const lines = offered.reply!.split("\n").filter((l) => /^\d\)/.test(l));
    expect(lines).toHaveLength(3);
    // One of each kind, cheapest first in the text.
    expect((lead().profile as { offers: Array<{ tier: string }> }).offers.map((o) => o.tier).sort()).toEqual(["free", "managed", "paid"]);
  });

  it("never offers two homes from the same manager, and offers all four when exactly four fit", async () => {
    catalog = [SVC_HOME, home("prop-4709b", "managed", OWNER_SVC, WS_SVC, { rent: 1060, street: "4711 8th Ave NE", name: "Eighth Avenue Annex" }), LENA_HOME, MARCUS_HOME, home("prop-uw-9", "free", "owner-9", "ws-9", { rent: 1190, street: "300 15th Ave NE", name: "Fifteenth Nine House" })];
    for (const body of ["what houses are in seattle?", "under 1200", "dec 1 for 6 months", "near UW"]) await text(body);
    // Five rooms fit (the Eighth Avenue Annex is a second room of the PropLane manager), so the headcount is still asked.
    expect((await text("private, furnished")).reply).toBe("How many people will be moving in?");
    await text("just me");
    const offers = (lead().profile as { offers: Array<{ propertyId: string }> }).offers;
    expect(offers).toHaveLength(4);
    expect(offers.map((o) => o.propertyId)).not.toContain("prop-4709b");
  });
});
