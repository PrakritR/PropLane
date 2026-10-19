/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for a PostgREST client and untyped .mjs scripts */
// A stranger texts the PropLane number with no code. Through the real seam, router, role detection, lead
// qualifier, room matcher and assignment: welcome -> five questions -> rooms from every team -> a pick ->
// that one team owns the conversation, with the history and an alert, and the next text reaches it.
// The leasing agent that books the tour is a model; the journey is proven up to and including its hand-off.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";
import type { SharedLineConfig, SharedLineSend } from "@/lib/one-number/contracts";
import { LEAD_CONSTRAINTS, leadFakeDb, type LeadFakeDb } from "../../helpers/lead-fake-db";
import { storedListing } from "../../helpers/lead-listing-fixtures";

const sim = vi.hoisted(() => ({
  sent: [] as SharedLineSend[],
  alerts: [] as Array<Record<string, unknown>>,
  db: null as unknown,
  listings: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/service/service-catalog.server", () => ({ getServicePublicListings: vi.fn(async () => sim.listings) }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/one-number/send.server", () => ({
  sendSharedLineMessage: vi.fn(async (_db: unknown, send: SharedLineSend) => {
    sim.sent.push(send);
    return { ok: true as const, messageSid: "SMout", segments: 1 };
  }),
}));
vi.mock("@/lib/one-number/team-alerts.server", () => ({
  alertWorkspaceTeam: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    sim.alerts.push(input);
    return { sent: true };
  }),
}));
// The two side effects that write to the owner's inbox are real writes into the same fake database.
vi.mock("@/lib/manager-sms-messages.server", () => ({
  logManagerSmsMessage: vi.fn(async (db: LeadFakeDb["db"], input: Record<string, unknown>) => {
    await (db as any).from("manager_sms_messages").insert({
      manager_user_id: input.managerUserId, resident_phone: input.residentPhone, direction: input.direction, body: input.body,
      message_sid: input.messageSid, counterparty_role: input.counterpartyRole, workspace_id: input.workspaceId,
    });
    return true;
  }),
}));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({
  upsertManagerSmsContact: vi.fn(async (db: LeadFakeDb["db"], input: Record<string, unknown>) => {
    await (db as any).from("manager_sms_contacts").insert({
      manager_user_id: input.managerUserId, phone_e164: input.phoneE164 ?? input.phone, counterparty_role: input.counterpartyRole, workspace_id: input.workspaceId ?? null,
    });
    return { ok: true };
  }),
}));

import { publicListingProjection } from "@/lib/public-listings.server";
import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { NEUTRAL_REPLY } from "@/lib/one-number/lead-qualifying";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHONE = "+12065550142";
const KEY = "2065550142";
const config: SharedLineConfig = { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] };

const LISTINGS: MockProperty[] = [
  storedListing("prop-uw-a", { manager: OWNER_A, neighborhood: "University District", beds: 4, rent: 900, street: "4000 15th Ave NE", name: "Brooklyn House" }),
  storedListing("prop-uw-d", { manager: OWNER_B, neighborhood: "University District", beds: 4, rent: 950, street: "4200 17th Ave NE", name: "Seventeenth House" }),
].map((p) => publicListingProjection(p));

function world(): LeadFakeDb {
  return leadFakeDb(
    {
      sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550100" }],
      portal_workspaces: [
        { id: WS_A, name: "Brooklyn team", owner_user_id: OWNER_A, is_default: true },
        { id: WS_B, name: "Seventeenth team", owner_user_id: OWNER_B, is_default: true },
      ],
      manager_property_records: [
        { id: "prop-uw-a", workspace_id: WS_A, manager_user_id: OWNER_A, status: "live", property_data: { buildingName: "Brooklyn House", address: "4000 15th Ave NE" } },
        { id: "prop-uw-d", workspace_id: WS_B, manager_user_id: OWNER_B, status: "live", property_data: { buildingName: "Seventeenth House", address: "4200 17th Ave NE" } },
      ],
    },
    { constraints: LEAD_CONSTRAINTS },
  );
}

let sid = 0;
async function say(fake: LeadFakeDb, body: string, from = PHONE, key = KEY) {
  return handleSharedLineInbound(fake.db, { config, fromPhone: from, body, messageSid: `SM${++sid}`, mediaCount: 0, phoneKey: key });
}
const twiml = (r: Awaited<ReturnType<typeof say>>) => (r.kind === "handled" ? (r.twiml ?? "") : `<${r.kind}>`);

beforeEach(() => {
  sim.sent.length = 0;
  sim.alerts.length = 0;
  sim.listings = LISTINGS;
});

async function toOffers(fake: LeadFakeDb) {
  const out: string[] = [];
  out.push(twiml(await say(fake, "hi")));
  // Onboarding asks once who this is; "looking for a room" makes them a searcher.
  out.push(twiml(await say(fake, "looking for a room")));
  for (const answer of ["$1000", "Nov 1 for 6 months", "University District", "private bath, furnished", "just me"]) out.push(twiml(await say(fake, answer)));
  return out;
}

describe("a prospect with no code", () => {
  it("is welcomed once, asked one question at a time, offered rooms from every team, and every reply is one GSM-7 text", async () => {
    const fake = world();
    const replies = await toOffers(fake);
    expect(replies[0]).toMatch(/Are you looking for a place, renting one out, or a vendor\? Reply STOP to opt out\.$/);
    expect(replies[1]).toMatch(/Reply STOP to opt out\./);
    expect(replies[1]).toMatch(/monthly budget/);
    expect(replies[2]).toMatch(/move in/i);
    const offers = replies.at(-1)!;
    expect(offers).toContain("These rooms fit:");
    expect(offers).toContain("4000 15th Ave NE");
    expect(offers).toContain("4200 17th Ave NE");
    for (const r of replies) expect(/^[\x20-\x7E\n]*$/.test(r)).toBe(true);
    expect(sim.sent).toEqual([]); // before a team owns the lead the replies ride the webhook, billed to nobody
  });

  it("the offer reaches the prospect as one text per room, each with its own photo and listing link, then how to pick", async () => {
    const photo = (owner: string, id: string, street: string, name: string, rent: number, url: string) =>
      publicListingProjection(storedListing(id, { manager: owner, neighborhood: "University District", beds: 4, rent, street, name, photo: url }));
    sim.listings = [
      photo(OWNER_A, "prop-uw-a", "4000 15th Ave NE", "Brooklyn House", 900, "https://cdn.example.com/a.jpg"),
      photo(OWNER_B, "prop-uw-d", "4200 17th Ave NE", "Seventeenth House", 950, "https://cdn.example.com/d.jpg"),
    ];
    const fake = world();
    await say(fake, "hi");
    await say(fake, "looking for a room");
    for (const answer of ["$1000", "Nov 1 for 6 months", "University District", "private bath, furnished"]) await say(fake, answer);
    const last = await say(fake, "just me");
    expect(last.kind).toBe("handled");
    const bubbles = last.kind === "handled" ? last.bubbles ?? [] : [];
    // Two rooms + the pick prompt, welcome notice not repeated (it was sent with the first reply).
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]!.body).toContain("4000 15th Ave NE");
    expect(bubbles[0]!.body).toContain("/rent/listings/prop-uw-a");
    expect(bubbles[0]!.mediaUrl).toBe("https://cdn.example.com/a.jpg");
    expect(bubbles[1]!.body).toContain("4200 17th Ave NE");
    expect(bubbles[1]!.mediaUrl).toBe("https://cdn.example.com/d.jpg");
    expect(bubbles[2]).toEqual({ body: "Reply 1 or 2 to pick one, or TOUR to see it." });
    for (const b of bubbles) expect(/^[\x20-\x7E]*$/.test(b.body)).toBe(true);
    expect(sim.sent).toEqual([]);
  });

  it("a fair-housing question gets the neutral answer and changes nothing that is offered", async () => {
    const fake = world();
    await toOffers(fake);
    const before = JSON.stringify(fake.rows.sms_unassigned_leads![0]!.profile);
    const reply = twiml(await say(fake, "are there many families with kids in that house?"));
    expect(reply.startsWith(NEUTRAL_REPLY)).toBe(true);
    expect(JSON.stringify(fake.rows.sms_unassigned_leads![0]!.profile)).toBe(before);
    expect(fake.rows.sms_unassigned_leads![0]!.status).toBe("open");
  });

  it("a pick gives the lead to exactly that house's team: history copied, only that team alerted, and the next text reaches them", async () => {
    const fake = world();
    await toOffers(fake);
    const pick = await say(fake, "2");
    expect(fake.rows.sms_unassigned_leads![0]).toMatchObject({ status: "assigned", assigned_workspace_id: WS_B, assigned_property_id: "prop-uw-d" });

    // Only the picked team hears about it.
    expect(sim.alerts).toHaveLength(1);
    expect(sim.alerts[0]).toMatchObject({ workspaceId: WS_B, ownerUserId: OWNER_B, kind: "new_lead", propertyId: "prop-uw-d" });
    // The conversation so far now sits in THAT owner's inbox as a prospect thread, stamped with the workspace.
    const thread = fake.rows.manager_sms_messages!;
    expect(thread.length).toBeGreaterThan(8);
    expect(thread.every((m) => m.manager_user_id === OWNER_B && m.workspace_id === WS_B && m.resident_phone === PHONE)).toBe(true);
    expect(thread.some((m) => String(m.body).includes("$1000"))).toBe(true);
    // Nothing of it reached team A.
    expect(JSON.stringify(fake.rows)).not.toContain(`"manager_user_id":"${OWNER_A}","resident_phone"`);

    // The pick's own text is the leasing agent's: it continues into team B's pipeline as a prospect.
    expect(pick).toMatchObject({ kind: "continue", owned: { workspaceId: WS_B, managerId: OWNER_B } });
    // And the phone's next text ("can I tour Saturday?") goes there too, no question asked.
    expect(await say(fake, "can I tour it Saturday at 2?")).toMatchObject({ kind: "continue", owned: { workspaceId: WS_B, managerId: OWNER_B } });
    expect(sim.sent).toEqual([]);
  });

  it("a Twilio retry of a lead's text gets the same reply and stores one turn", async () => {
    const fake = world();
    await say(fake, "hi");
    await say(fake, "looking for a room");
    const input = { config, fromPhone: PHONE, body: "$1000", messageSid: "SM-retry-1", mediaCount: 0, phoneKey: KEY };
    const first = await handleSharedLineInbound(fake.db, input);
    const turns = fake.rows.sms_unassigned_lead_turns!.length;
    const second = await handleSharedLineInbound(fake.db, input);
    expect(twiml(second)).toBe(twiml(first));
    expect(fake.rows.sms_unassigned_lead_turns).toHaveLength(turns);
  });

  // Idempotent per MessageSid: the retry gets the recorded question back and onboarding does not advance twice.
  it("a Twilio retry of the very first text repeats the same role question", async () => {
    const fake = world();
    const input = { config, fromPhone: PHONE, body: "hi", messageSid: "SM-retry-0", mediaCount: 0, phoneKey: KEY };
    const first = await handleSharedLineInbound(fake.db, input);
    const second = await handleSharedLineInbound(fake.db, input);
    expect(twiml(second)).toBe(twiml(first));
  });

  it("a retry of a later answer returns the same reply and does not advance the conversation twice", async () => {
    const fake = world();
    await say(fake, "hi");
    const input = { config, fromPhone: PHONE, body: "looking for a room", messageSid: "SM-retry-1", mediaCount: 0, phoneKey: KEY };
    const first = await handleSharedLineInbound(fake.db, input);
    const turns = fake.rows.sms_unassigned_lead_turns?.length;
    const second = await handleSharedLineInbound(fake.db, input);
    expect(twiml(second)).toBe(twiml(first));
    expect(fake.rows.sms_unassigned_lead_turns?.length).toBe(turns);
    expect(fake.rows.sms_onboarding_state).toHaveLength(1);
  });

  it("two strangers at once do not see each other's leads", async () => {
    const fake = world();
    await say(fake, "hi", "+12065550301", "2065550301");
    await say(fake, "looking for a room", "+12065550301", "2065550301");
    await say(fake, "$900", "+12065550301", "2065550301");
    await say(fake, "hello", "+12065550302", "2065550302");
    await say(fake, "looking for a room", "+12065550302", "2065550302");
    const leads = fake.rows.sms_unassigned_leads!;
    expect(leads).toHaveLength(2);
    expect(leads.find((l) => l.phone_key === "2065550302")!.profile).not.toMatchObject({ budgetMax: 900 });
  });
});
