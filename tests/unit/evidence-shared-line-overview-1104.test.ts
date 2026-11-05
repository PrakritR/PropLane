/**
 * Evidence harness — the 206 PropLane line answers "is there availability?" with the open homes
 * FIRST, instead of opening a budget questionnaire.
 *
 * The whole turn runs over the lead fake database (`handleUnassignedLeadInbound`, the same entry the
 * inbound webhook calls), so the lines printed below are the texts the prospect's phone receives,
 * in order, with the MMS photo each one carries. With EVIDENCE_DIR set it writes
 * `shared-line-overview.txt`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { MockProperty } from "@/data/types";
import { LEAD_CONSTRAINTS, leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";
import { storedListing } from "../helpers/lead-listing-fixtures";

const mocks = vi.hoisted(() => ({
  log: vi.fn(async () => true),
  alert: vi.fn(async () => ({ sent: true })),
  contact: vi.fn(async () => ({ ok: true })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: () => mocks.log() }));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: () => mocks.contact() }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: () => mocks.alert() }));

import { publicListingProjection } from "@/lib/public-listings.server";
import { handleUnassignedLeadInbound, type LeadDeps } from "@/lib/one-number/unassigned-leads.server";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHONE_KEY = "2065550142";
const NOW = new Date("2026-10-18T20:00:00Z");

const LISTINGS: MockProperty[] = [
  storedListing("prop-uw-a", { manager: OWNER_A, neighborhood: "University District", beds: 4, rent: 900, street: "4000 15th Ave NE", name: "Brooklyn House" }),
  storedListing("prop-uw-d", { manager: OWNER_B, neighborhood: "University District", beds: 4, rent: 950, street: "4200 17th Ave NE", name: "Seventeenth House" }),
  storedListing("prop-uw-over", { manager: OWNER_A, neighborhood: "University District", beds: 4, rent: 1700, street: "4300 19th Ave NE", name: "Pricey House" }),
].map((p) => publicListingProjection(p));

const WITH_BALLARD: MockProperty[] = [
  ...LISTINGS,
  publicListingProjection(storedListing("prop-ballard", { manager: OWNER_A, neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St", name: "Ballard House" })),
];

let sid = 0;
const deps = (over: Partial<LeadDeps> = {}): LeadDeps => ({
  now: () => NOW,
  listings: async () => LISTINGS,
  extract: async () => null,
  origin: () => "https://proplane.ai",
  ...over,
});

function seed(): LeadFakeDb {
  return leadFakeDb(
    {
      sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550100" }],
      portal_workspaces: [
        { id: WS_A, name: "Brooklyn team", owner_user_id: OWNER_A, is_default: true, is_service: true },
        { id: WS_B, name: "Seventeenth team", owner_user_id: OWNER_B, is_default: true, is_service: true },
      ],
      manager_property_records: [
        { id: "prop-uw-a", workspace_id: WS_A, manager_user_id: OWNER_A, status: "live", property_data: { buildingName: "Brooklyn House", address: "4000 15th Ave NE" } },
        { id: "prop-uw-d", workspace_id: WS_B, manager_user_id: OWNER_B, status: "live", property_data: { buildingName: "Seventeenth House", address: "4200 17th Ave NE" } },
      ],
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

async function say(fake: LeadFakeDb, body: string, over: Partial<LeadDeps> = {}) {
  sid += 1;
  return handleUnassignedLeadInbound(
    fake.db,
    { fromPhone: `+1${PHONE_KEY}`, phoneKey: PHONE_KEY, body, messageSid: `SM${sid}`, mediaCount: 0 },
    deps(over),
  );
}

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say_ = (line = "") => log.push(line);
afterAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/shared-line-overview.txt`, `${log.join("\n")}\n`);
});

function printTurn(inbound: string, turn: { reply: string | null; bubbles?: Array<{ body: string; mediaUrl?: string }> }) {
  say_(`  (206) prospect →  ${inbound}`);
  const bubbles = turn.bubbles ?? (turn.reply ? [{ body: turn.reply }] : []);
  for (const bubble of bubbles) {
    say_(`  PropLane →        ${bubble.body}`);
    if (bubble.mediaUrl) say_(`                    [photo] ${bubble.mediaUrl}`);
  }
  say_();
}

beforeEach(() => {
  sid = 0;
});

describe("a question about what is open is answered with the open homes", () => {
  it("texts the homes, their price, the listing page and the tour page before asking anything", async () => {
    const fake = seed();
    say_("=========================================================================");
    say_("The PropLane 206 line — a stranger asks what is available");
    say_("=========================================================================");
    say_();

    const first = await say(fake, "Hi, is there availability?");
    printTurn("Hi, is there availability?", first);

    const bodies = (first.bubbles ?? []).map((b) => b.body);
    expect(bodies[0]!.startsWith("Hi, this is PropLane. Reply STOP to opt out.")).toBe(true);
    // The homes come first, drawn from the public catalog: price, availability, listing page, tour page.
    const all = bodies.join("\n");
    expect(all).toContain("from $900/mo");
    expect(all).toContain("https://proplane.ai/rent/listings/prop-uw-a");
    expect(all).toContain("https://proplane.ai/rent/tours-contact?propertyId=prop-uw-a");
    expect(all).toMatch(/tap Apply/);
    // Not the old first move.
    expect(first.reply).not.toBe("Hi, this is PropLane. Reply STOP to opt out. What is your monthly budget for rent?");

    // A budget typed as "900$" now narrows the list instead of "Sorry, I did not get that."
    const narrowed = await say(fake, "900$");
    printTurn("900$", narrowed);
    expect(narrowed.reply).not.toContain("Sorry, I did not get that");
    const offers = (fake.rows.sms_unassigned_leads![0]!.profile as { offers: Array<{ rent: number }> }).offers;
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.rent <= 900)).toBe(true);

    // The overview goes out once: the same question again does not repeat the list.
    const again = await say(fake, "Is there availability");
    expect((again.bubbles ?? []).filter((b) => b.body.includes("Photos and details"))).toHaveLength(0);

    say_("  (nothing above names a neighbourhood's people, a door code or a private number)");
  });

  it("says so plainly when nothing is open, and never invents a room", async () => {
    const fake = seed();
    const turn = await handleUnassignedLeadInbound(
      fake.db,
      { fromPhone: `+1${PHONE_KEY}`, phoneKey: PHONE_KEY, body: "any rooms open?", messageSid: "SM-empty", mediaCount: 0 },
      { ...deps(), listings: async () => [] },
    );
    say_();
    printTurn("any rooms open?  (with nothing live in the catalog)", turn);
    expect(turn.reply).toContain("I do not see an open room listed right now.");
  });
});

describe("a follow-up question after the overview", () => {
  // The overview leaves the lead at stage "offered" on its very first text, so the prospect's SECOND message is read
  // as a refinement. A question is not a place: it must never be stored as an area filter that empties the open homes.
  it("answers about the rooms standing — never 'nothing fits' while they are open — and still narrows on a real area", async () => {
    const fake = seed();
    say_();
    say_("=========================================================================");
    say_("The same line — the prospect asks questions instead of picking a room");
    say_("=========================================================================");
    say_();

    const first = await say(fake, "any rooms open?", { listings: async () => WITH_BALLARD });
    printTurn("any rooms open?", first);

    for (const question of ["do you have anything cheaper?", "can I see photos?", "is parking included?"]) {
      const turn = await say(fake, question, { listings: async () => WITH_BALLARD });
      printTurn(question, turn);
      // The rooms already offered come back with their listing pages, where price, photos and what is included live.
      expect(turn.reply).toContain("Photos, pricing and what is included are on each listing page:");
      expect(turn.reply).toContain("https://proplane.ai/rent/listings/prop-ballard");
      expect(turn.reply).not.toContain("I do not have a room that fits right now");
      const lead = fake.rows.sms_unassigned_leads![0]!;
      const stored = lead.profile as { area?: string; stage: string; offers: unknown[] };
      expect(stored.area).toBeUndefined();
      expect(stored.stage).toBe("offered");
      expect(stored.offers.length).toBeGreaterThan(0);
      expect(lead.status).toBe("open");
    }

    const narrowed = await say(fake, "do you have anything in Ballard?", { listings: async () => WITH_BALLARD });
    printTurn("do you have anything in Ballard?", narrowed);
    expect((fake.rows.sms_unassigned_leads![0]!.profile as { area?: string }).area).toContain("Ballard");
    expect(narrowed.reply).toContain("https://proplane.ai/rent/listings/prop-ballard");
    expect(narrowed.reply).not.toContain("prop-uw-a");
    say_("  (the questions keep the three open rooms; only a real neighbourhood narrows them)");
  });
});
