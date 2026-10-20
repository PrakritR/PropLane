// The Unassigned-leads agent end to end over a fake database: first reply, qualifying order, fair housing,
// matching public rooms, assignment to exactly one workspace, webhook retries and the admin queue helpers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";
import { LEAD_CONSTRAINTS, leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";
import { storedListing } from "../helpers/lead-listing-fixtures";

const mocks = vi.hoisted(() => ({
  log: vi.fn(async (..._args: unknown[]) => true),
  alert: vi.fn(async (..._args: unknown[]) => ({ sent: true })),
  contact: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: (...args: unknown[]) => mocks.log(...args) }));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: (...args: unknown[]) => mocks.contact(...args) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: (...args: unknown[]) => mocks.alert(...args) }));

import { publicListingProjection } from "@/lib/public-listings.server";
import { NEUTRAL_REPLY, WELCOME } from "@/lib/one-number/lead-qualifying";
import { NO_MATCH_TEXT } from "@/lib/one-number/lead-match";
import {
  assignLeadToHouse,
  closeLead,
  e164FromPhoneKey,
  handleUnassignedLeadInbound,
  listOpenLeads,
  maskPhoneKey,
  type LeadDeps,
} from "@/lib/one-number/unassigned-leads.server";

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
  storedListing("prop-ballard", { manager: OWNER_A, neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St", name: "Ballard House" }),
].map((p) => publicListingProjection(p));

let sidCounter = 0;
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
      // Both are PropLane-managed: the line's offers are drawn from the `is_service` catalog alone, so a prospect
      // can only ever pick a house in one of these (`assignLeadToHouse` re-asserts the flag for a prospect pick).
      portal_workspaces: [
        { id: WS_A, name: "Brooklyn team", owner_user_id: OWNER_A, is_default: true, is_service: true },
        { id: WS_B, name: "Seventeenth team", owner_user_id: OWNER_B, is_default: true, is_service: true },
      ],
      manager_property_records: [
        { id: "prop-uw-a", workspace_id: WS_A, manager_user_id: OWNER_A, status: "live", property_data: { buildingName: "Brooklyn House", address: "4000 15th Ave NE" } },
        { id: "prop-uw-d", workspace_id: WS_B, manager_user_id: OWNER_B, status: "live", property_data: { buildingName: "Seventeenth House", address: "4200 17th Ave NE" } },
        { id: "prop-draft", workspace_id: WS_A, manager_user_id: OWNER_A, status: "draft", property_data: { buildingName: "Draft House" } },
      ],
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

async function say(fake: LeadFakeDb, body: string, over: Partial<LeadDeps> = {}, sid?: string) {
  sidCounter += 1;
  return handleUnassignedLeadInbound(
    fake.db,
    { fromPhone: `+1${PHONE_KEY}`, phoneKey: PHONE_KEY, body, messageSid: sid ?? `SM${sidCounter}`, mediaCount: 0 },
    deps(over),
  );
}

const lead = (fake: LeadFakeDb) => fake.rows.sms_unassigned_leads![0]!;
const profile = (fake: LeadFakeDb) => lead(fake).profile as Record<string, unknown>;

/** Walk a lead to the point where two rooms have been offered. */
async function toOffered(fake: LeadFakeDb) {
  await say(fake, "hi");
  await say(fake, "$1000");
  await say(fake, "Nov 1 for 6 months");
  await say(fake, "University District");
  await say(fake, "private bath, furnished");
  return say(fake, "just me");
}

beforeEach(() => {
  mocks.log.mockClear();
  mocks.alert.mockClear();
  mocks.contact.mockClear();
});

describe("the first reply", () => {
  it("names PropLane, says how to opt out, and asks the budget", async () => {
    const fake = seed();
    const turn = await say(fake, "hi");
    expect(turn.reply).toBe(`${WELCOME} What is your monthly budget for rent?`);
    expect(turn.reply).toBe("Hi, this is PropLane. Reply STOP to opt out. What is your monthly budget for rent?");
    expect(turn.reply!.length).toBeLessThanOrEqual(160);
    expect(turn.assignedWorkspaceId).toBeNull();
    expect(lead(fake)).toMatchObject({ phone_key: PHONE_KEY, status: "open" });
    expect(profile(fake)).toMatchObject({ stage: "qualifying", asked: "budget" });
    const turns = fake.rows.sms_unassigned_lead_turns!;
    expect(turns.map((t) => t.direction)).toEqual(["inbound", "outbound"]);
    expect(turns[0]!.body).toBe("hi");
  });

  it("does not repeat the welcome on later texts, and reads a first text that already answers things", async () => {
    const fake = seed();
    const first = await say(fake, "Looking for a room under $1100 near UW, move in Nov 1 for 6 months");
    expect(first.reply!.startsWith(WELCOME)).toBe(true);
    expect(first.reply).toContain("Do you want a private or shared bath, and furnished or unfurnished?");
    expect(profile(fake)).toMatchObject({ budgetMax: 1100, moveInDate: "2026-11-01", leaseMonths: 6, area: "UW", asked: "room" });
    const second = await say(fake, "shared and furnished");
    expect(second.reply).not.toContain("PropLane");
    expect(second.reply).toBe("How many people will be moving in?");
  });

  it("asks again, plainly, when a text answers nothing", async () => {
    const fake = seed();
    await say(fake, "hi");
    const turn = await say(fake, "asdf");
    expect(turn.reply).toBe("Sorry, I did not get that. What is your monthly budget for rent?");
  });
});

describe("qualifying order", () => {
  it("one question at a time: budget, move-in and lease, area, room type, household", async () => {
    const fake = seed();
    const replies = [
      (await say(fake, "hi")).reply,
      (await say(fake, "$1000")).reply,
      (await say(fake, "Nov 1 for 6 months")).reply,
      (await say(fake, "University District")).reply,
      (await say(fake, "shared bath, furnished")).reply,
    ];
    expect(replies[0]).toContain("monthly budget");
    expect(replies[1]).toBe("When do you want to move in, and for how many months?");
    expect(replies[2]).toBe("Which area, or what commute, do you want? A school, office or neighborhood name works.");
    expect(replies[3]).toBe("Do you want a private or shared bath, and furnished or unfurnished?");
    expect(replies[4]).toBe("How many people will be moving in?");
    // Every reply is plain GSM-7.
    for (const reply of replies) expect(/^[\x20-\x7E\n]*$/.test(reply!)).toBe(true);
  });

  it("falls back to the model for an answer the extractors cannot read, then validates it", async () => {
    const fake = seed();
    await say(fake, "hi");
    const extract = vi.fn(async () => ({ budgetMax: 1400 }));
    const turn = await say(fake, "a couple grand a month, give or take", { extract });
    expect(extract).toHaveBeenCalledOnce();
    expect(profile(fake).budgetMax).toBe(1400);
    expect(turn.reply).toContain("move in");
  });

  it("never calls the model when the text was read deterministically", async () => {
    const fake = seed();
    await say(fake, "hi");
    const extract = vi.fn(async () => ({ budgetMax: 1 }));
    await say(fake, "$1,250", { extract });
    expect(extract).not.toHaveBeenCalled();
    expect(profile(fake).budgetMax).toBe(1250);
  });
});

describe("fair housing", () => {
  it("answers a question about people neutrally, stores no answer, and asks the same question again", async () => {
    const fake = seed();
    await say(fake, "hi");
    const extract = vi.fn(async (input: { text: string }) => {
      expect(input.text).not.toMatch(/religion/i);
      return null;
    });
    const turn = await say(fake, "what religion are the other tenants?", { extract });
    expect(turn.reply).toBe(`${NEUTRAL_REPLY} What is your monthly budget for rent?`);
    expect(profile(fake)).toMatchObject({ stage: "qualifying", asked: "budget" });
    expect(profile(fake).budgetMax).toBeUndefined();
    expect(JSON.stringify(profile(fake))).not.toMatch(/relig|tenant/i);
  });

  it("keeps the price from a mixed text and nothing else", async () => {
    const fake = seed();
    await say(fake, "hi");
    const turn = await say(fake, "budget is 1200, and no kids around please");
    expect(profile(fake).budgetMax).toBe(1200);
    expect(turn.reply!.startsWith(NEUTRAL_REPLY)).toBe(true);
    expect(JSON.stringify(profile(fake))).not.toMatch(/kids|children|famil/i);
  });

  it("never lets a protected topic change what is offered", async () => {
    const fake = seed();
    const offered = await toOffered(fake);
    expect(offered.reply).toContain("These rooms fit:");
    const offersBefore = JSON.stringify(profile(fake).offers);
    const turn = await say(fake, "are there many families with kids in that house?");
    expect(turn.reply).toBe(`${NEUTRAL_REPLY} Reply 1 or 2 to pick a room, or TOUR to see one.`);
    expect(turn.assignedWorkspaceId).toBeNull();
    expect(JSON.stringify(profile(fake).offers)).toBe(offersBefore);
    expect(lead(fake).status).toBe("open");
  });

  it("no reply it writes describes a neighborhood or its people", async () => {
    const fake = seed();
    const sent: string[] = [];
    for (const text of ["hi", "$1000", "Nov 1 for 6 months", "University District", "private bath, furnished", "just me"]) {
      sent.push((await say(fake, text)).reply ?? "");
    }
    for (const reply of sent) expect(reply).not.toMatch(/safe|quiet neighborhood|family|families|kids|religio|diverse|young|professional/i);
  });
});

describe("matching public rooms", () => {
  it("offers rooms across every workspace that fit, with price, availability and a public link", async () => {
    const fake = seed();
    const turn = await toOffered(fake);
    expect(turn.reply).toContain("1) 4000 15th Ave NE, $900/mo, available now: https://proplane.ai/rent/listings/prop-uw-a");
    expect(turn.reply).toContain("$900/mo");
    expect(turn.reply).toContain("https://proplane.ai/rent/listings/prop-uw-a");
    expect(turn.reply).toContain("https://proplane.ai/rent/listings/prop-uw-d");
    expect(turn.reply).not.toContain("prop-uw-over");
    expect(turn.reply).not.toContain("prop-ballard");
    expect(turn.reply).toMatch(/Reply 1 or 2 to pick one, or TOUR to see it\.$/);
    expect(profile(fake)).toMatchObject({ stage: "offered", asked: "pick" });
    expect((profile(fake).offers as Array<{ propertyId: string }>).map((o) => o.propertyId)).toEqual(["prop-uw-a", "prop-uw-d"]);
  });

  it("carries nothing private from the listing", async () => {
    const fake = seed();
    const turn = await toOffered(fake);
    for (const secret of [OWNER_A, OWNER_B, "mail.proplane.app", "+12065550100", "Lockbox", "001000", "welcome-home", "secret-invite"]) {
      expect(turn.reply).not.toContain(secret);
    }
  });

  it("says so honestly when nothing fits and keeps the lead open", async () => {
    const none = seed();
    await say(none, "hi");
    await say(none, "$250");
    await say(none, "Nov 1 for 6 months");
    await say(none, "Tacoma");
    await say(none, "shared bath, furnished");
    const out = await say(none, "just me");
    expect(out.reply).toBe(NO_MATCH_TEXT);
    expect(profile(none)).toMatchObject({ stage: "no_match" });
    expect(lead(none).status).toBe("open");
  });

  it("a failed catalog read is not 'no room': it says so and searches again on the next text", async () => {
    const fake = seed();
    for (const text of ["hi", "$1000", "Nov 1 for 6 months", "University District", "private bath, furnished"]) await say(fake, text);
    const failed = await say(fake, "just me", { listings: async () => { throw new Error("catalog down"); } });
    expect(failed.reply).toBe("I could not check rooms just now. Text me again in a minute and I will try again.");
    expect(profile(fake).stage).toBe("qualifying");
    const retry = await say(fake, "ok");
    // "ok" is an acknowledgement, never an area: the same rooms come back.
    expect(retry.reply).toContain("These rooms fit:");
    expect(retry.reply).toContain("prop-uw-d");
    expect(profile(fake).area).toBe("University District");
  });

  it("a decline asks what to change and searches again on the new answer", async () => {
    const fake = seed();
    await toOffered(fake);
    const declined = await say(fake, "none of those");
    expect(declined.reply).toBe("No problem. Send a new budget, area or move-in date and I will search again.");
    expect(profile(fake)).toMatchObject({ stage: "qualifying", asked: "refine" });
    const again = await say(fake, "up to 1800");
    expect(again.reply).toContain("These rooms fit:");
    expect(again.reply).toContain("prop-uw-over");
  });
});

describe("assignment to exactly one workspace", () => {
  it("a pick hands the lead to that house's workspace, copies the history there once and alerts only that team", async () => {
    const fake = seed();
    await toOffered(fake);
    const turn = await say(fake, "2");
    expect(turn.assignedWorkspaceId).toBe(WS_B);
    expect(turn.reply).toBeNull();

    expect(lead(fake)).toMatchObject({ status: "assigned", assigned_workspace_id: WS_B, assigned_property_id: "prop-uw-d" });

    // The history (everything except the "2" that triggers the leasing agent) lands in that owner's prospect conversation.
    const calls = mocks.log.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      expect(call.managerUserId).toBe(OWNER_B);
      expect(call.counterpartyRole).toBe("prospect");
      expect(call.workspaceId).toBe(WS_B);
      expect(call.residentPhone).toBe("+12065550142");
    }
    expect(calls.map((c) => c.body)).not.toContain("2");
    expect(calls.filter((c) => c.direction === "inbound").map((c) => c.body)).toContain("$1000");
    expect(calls.some((c) => typeof c.body === "string" && c.body.includes("These rooms fit:"))).toBe(true);
    // Stable ids, so a replay is idempotent downstream.
    expect(new Set(calls.map((c) => c.messageSid)).size).toBe(calls.length);

    expect(mocks.alert).toHaveBeenCalledOnce();
    expect(mocks.alert.mock.calls[0]![1]).toMatchObject({ workspaceId: WS_B, ownerUserId: OWNER_B, kind: "new_lead", propertyId: "prop-uw-d" });
    expect(String((mocks.alert.mock.calls[0]![1] as { text: string }).text)).toContain("Seventeenth House");

    expect(mocks.contact).toHaveBeenCalledOnce();
    expect(mocks.contact.mock.calls[0]![1]).toMatchObject({ managerUserId: OWNER_B, counterpartyRole: "prospect" });

    // The phone's session now points at that workspace as a prospect.
    expect(fake.rows.sms_line_sessions![0]).toMatchObject({ phone_key: PHONE_KEY, current_workspace_id: WS_B, active_role: "prospect" });
  });

  it("assigns once: a second assignment finds the lead closed to it and copies nothing", async () => {
    const fake = seed();
    await toOffered(fake);
    await say(fake, "1");
    const copied = mocks.log.mock.calls.length;
    const again = await assignLeadToHouse(fake.db, { leadId: String(lead(fake).id), propertyId: "prop-uw-d", by: "admin" }, deps());
    expect(again).toEqual({ ok: false, error: "lead_not_open" });
    expect(mocks.log.mock.calls.length).toBe(copied);
    expect(mocks.alert).toHaveBeenCalledOnce();
    expect(lead(fake).assigned_workspace_id).toBe(WS_A);
  });

  it("'tour' with two offers asks which, and 'the second one' then picks it", async () => {
    const fake = seed();
    await toOffered(fake);
    const ask = await say(fake, "TOUR");
    expect(ask.reply).toBe("Which one? Reply 1 or 2 to pick a room, or TOUR to see one.");
    expect(ask.assignedWorkspaceId).toBeNull();
    const picked = await say(fake, "the second one");
    expect(picked.assignedWorkspaceId).toBe(WS_B);
  });

  it("re-derives the house from the database: a house that is no longer live is never assigned", async () => {
    const fake = seed();
    await toOffered(fake);
    fake.rows.manager_property_records!.find((r) => r.id === "prop-uw-a")!.status = "draft";
    const turn = await say(fake, "1");
    expect(turn.assignedWorkspaceId).toBeNull();
    expect(turn.reply).toBe("That room is no longer available. Send a new budget or area and I will search again.");
    expect(lead(fake).status).toBe("open");
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("an unknown or draft house is refused for an admin assignment too, and the lead stays open", async () => {
    const fake = seed();
    await say(fake, "hi");
    const id = String(lead(fake).id);
    expect(await assignLeadToHouse(fake.db, { leadId: id, propertyId: "prop-draft", by: "admin" })).toEqual({ ok: false, error: "house_not_found" });
    expect(await assignLeadToHouse(fake.db, { leadId: id, propertyId: "nope", by: "admin" })).toEqual({ ok: false, error: "house_not_found" });
    expect(lead(fake).status).toBe("open");
  });

  it("an admin assignment copies the whole conversation, including the last text", async () => {
    const fake = seed();
    await say(fake, "hi");
    await say(fake, "$1000");
    const result = await assignLeadToHouse(fake.db, { leadId: String(lead(fake).id), propertyId: "prop-uw-a", by: "admin" }, deps());
    expect(result).toMatchObject({ ok: true, workspaceId: WS_A, ownerUserId: OWNER_A, label: "Brooklyn House" });
    const bodies = mocks.log.mock.calls.map((c) => (c[1] as { body: string }).body);
    expect(bodies).toContain("$1000");
    expect(bodies).toHaveLength(4);
    expect(mocks.alert.mock.calls[0]![1]).toMatchObject({ workspaceId: WS_A });
  });
});

describe("webhook retries and hygiene", () => {
  it("a retried webhook gets the same reply and stores nothing twice", async () => {
    const fake = seed();
    const first = await say(fake, "hi", {}, "SMRETRY");
    const turns = fake.rows.sms_unassigned_lead_turns!.length;
    const retry = await say(fake, "hi", {}, "SMRETRY");
    expect(retry.reply).toBe(first.reply);
    expect(fake.rows.sms_unassigned_lead_turns).toHaveLength(turns);
    expect(fake.rows.sms_unassigned_leads).toHaveLength(1);
  });

  it("one open lead per phone: a second text finds the same lead", async () => {
    const fake = seed();
    await say(fake, "hi");
    await say(fake, "$900");
    expect(fake.rows.sms_unassigned_leads).toHaveLength(1);
  });

  it("never stores a card, bank or SSN number a stranger texts", async () => {
    const fake = seed();
    await say(fake, "hi");
    await say(fake, "my card is 4242 4242 4242 4242 and ssn 123-45-6789, routing 021000021");
    const stored = fake.rows.sms_unassigned_lead_turns!.map((t) => String(t.body)).join("\n");
    expect(stored).not.toContain("4242");
    expect(stored).not.toContain("123-45-6789");
    expect(stored).not.toContain("021000021");
    expect(stored).toContain("[redacted]");
  });

  it("fails closed: with the tables missing nothing is stored and nothing is said", async () => {
    const fake = leadFakeDb({}, { broken: ["sms_unassigned_leads", "sms_unassigned_lead_turns"] });
    expect(await say(fake, "hi")).toEqual({ leadId: null, reply: null, assignedWorkspaceId: null });
  });
});

// Review fix, Oct 20. "The first text always gets a reply" is a required criterion, and several paths answered
// Twilio with empty TwiML instead - a lead store that could not be read or written, or an unexpected throw. Twilio
// does not retry an empty 200, and `profile.stage` may already be set, so the welcome was never sent at all. Every
// one of those paths now sends the deterministic first-text reply, recorded against the inbound sid so a retry
// replays it instead of asking twice. (A MISSING table is different and stays silent: see above.)
describe("a first text is never left unanswered", () => {
  const firstReply = `${WELCOME} What is your monthly budget for rent?`;

  it("answers when the lead store cannot be read", async () => {
    const fake = leadFakeDb({}, { failing: ["sms_unassigned_leads"] });
    expect(await say(fake, "hi")).toMatchObject({ leadId: null, reply: firstReply });
  });

  it("answers, and records the reply, when the inbound turn cannot be stored", async () => {
    const fake = leadFakeDb({}, { failing: ["sms_unassigned_lead_turns"] });
    const turn = await say(fake, "hi", {}, "SMFAIL");
    expect(turn.reply).toBe(firstReply);
    expect(turn.leadId).toBeTruthy();
  });

  /** An unexpected throw partway through the turn: the clock gives out after the inbound turn is stored. */
  const throwingClock = () => {
    let calls = 0;
    return () => {
      calls += 1;
      if (calls > 2) throw new Error("clock exploded");
      return new Date("2026-10-18T20:00:00Z");
    };
  };

  it("answers when the turn throws outright", async () => {
    const fake = seed();
    const turn = await say(fake, "hi", { now: throwingClock() });
    expect(turn.reply).toBe(firstReply);
    // Recorded against this inbound sid, so the retry replays it rather than asking again.
    const replies = fake.rows.sms_unassigned_lead_turns!.filter((t) => String(t.message_sid ?? "").startsWith("reply:"));
    expect(replies).toHaveLength(1);
    expect(String(replies[0]!.body)).toBe(firstReply);
  });

  it("a retry of a first turn whose reply was never recorded gets the reply, not silence", async () => {
    const fake = seed();
    // The first worker stored the inbound turn and died before recording its reply.
    await say(fake, "hi", { now: throwingClock() }, "SMHALF");
    fake.rows.sms_unassigned_lead_turns = fake.rows.sms_unassigned_lead_turns!.filter((t) => t.message_sid === "SMHALF");
    const retry = await say(fake, "hi", {}, "SMHALF");
    expect(retry.reply).toBe(firstReply);
  });

  it("a text mid-conversation is NOT answered with the welcome again", async () => {
    const fake = seed();
    await say(fake, "hi");
    const turn = await say(fake, "$900", { now: throwingClock() });
    expect(turn.reply ?? "").not.toContain(WELCOME);
  });
});

describe("the admin queue", () => {
  it("masks phones to the last four and lists only open leads", async () => {
    const fake = seed();
    await say(fake, "hi");
    await say(fake, "$1000");
    fake.rows.sms_unassigned_leads!.push({ id: "closed-1", phone_key: "2065550199", status: "closed", profile: {}, last_inbound_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" });
    const list = await listOpenLeads(fake.db);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ phoneMasked: "•••• 0142", budgetMax: 1000, stage: "qualifying" });
    expect(JSON.stringify(list)).not.toContain(PHONE_KEY);
    expect(maskPhoneKey("2065550142")).toBe("•••• 0142");
  });

  it("closing a lead takes it out of the queue, once", async () => {
    const fake = seed();
    await say(fake, "hi");
    const id = String(lead(fake).id);
    expect(await closeLead(fake.db, id)).toBe(true);
    expect(await closeLead(fake.db, id)).toBe(false);
    expect((await listOpenLeads(fake.db)).items).toEqual([]);
  });

  it("a closed lead's phone starts a fresh lead on its next text", async () => {
    const fake = seed();
    await say(fake, "hi");
    await closeLead(fake.db, String(lead(fake).id));
    const turn = await say(fake, "hello again");
    expect(turn.reply!.startsWith(WELCOME)).toBe(true);
    expect(fake.rows.sms_unassigned_leads).toHaveLength(2);
  });

  it("turns a phone key into E.164", () => {
    expect(e164FromPhoneKey("2065550142")).toBe("+12065550142");
  });
});
