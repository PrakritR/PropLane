// A new room that fits a team's past prospect: texted once, only from that team's own houses.
import { describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";
import { leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";
import { storedListing } from "../helpers/lead-listing-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: vi.fn() }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: vi.fn(async () => true) }));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));

import { publicListingProjection } from "@/lib/public-listings.server";
import { hasSavedCriteria, newFittingRooms, roomKey, runProspectRoomMatches, type ProspectMatchDeps } from "@/lib/one-number/prospect-room-matches.server";
import type { LeadProfile } from "@/lib/one-number/lead-qualifying";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-19T20:00:00Z"); // 1pm Pacific
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const PROFILE: LeadProfile = { stage: "assigned", budgetMax: 1000, area: "University District", bathroom: "any", furnished: "any", household: 1, leaseMonths: 6, moveInDate: "2026-11-01" };

const listing = (id: string, rent = 800, hood = "University District") =>
  publicListingProjection(storedListing(id, { manager: "m", neighborhood: hood, beds: 4, rent, street: `${id} Elm St`, name: `House ${id}` }));

function setup(over: { profile?: Record<string, unknown>; mode?: string; leads?: Array<Record<string, unknown>> } = {}): LeadFakeDb {
  return leadFakeDb({
    sms_runtime_config: [{ singleton: true, line_mode: over.mode ?? "shared", shared_number_e164: "+12065550100" }],
    portal_workspaces: [
      { id: "ws-a", owner_user_id: "owner-a" },
      { id: "ws-b", owner_user_id: "owner-b" },
    ],
    manager_property_records: [
      { id: "old", workspace_id: "ws-a" },
      { id: "new", workspace_id: "ws-a" },
      { id: "theirs", workspace_id: "ws-b" },
    ],
    sms_unassigned_leads: over.leads ?? [
      {
        id: "lead-1",
        phone_key: "2065550123",
        status: "assigned",
        assigned_workspace_id: "ws-a",
        profile: over.profile ?? PROFILE,
        last_inbound_at: ago(30 * HOUR),
        updated_at: ago(30 * HOUR),
      },
    ],
  });
}

function harness(listings: () => Promise<MockProperty[]>, send = vi.fn(async () => ({ ok: true as const, messageSid: "SM1", segments: 1 }))) {
  const deps: ProspectMatchDeps = { now: () => NOW, listings, origin: () => "https://proplane.ai", send: send as unknown as ProspectMatchDeps["send"] };
  return { send, deps };
}

describe("pure helpers", () => {
  it("needs something to match on", () => {
    expect(hasSavedCriteria({})).toBe(false);
    expect(hasSavedCriteria({ budgetMax: 900 })).toBe(true);
    expect(hasSavedCriteria({ area: "UW" })).toBe(true);
  });
  it("nothing is new without a baseline; otherwise only unseen rooms", () => {
    const rows = [{ propertyId: "a", roomId: "1" }, { propertyId: "b", roomId: "2" }] as never[];
    expect(newFittingRooms(undefined, rows)).toEqual([]);
    expect(newFittingRooms(["a::1"], rows)).toEqual([rows[1]]);
    expect(roomKey({ propertyId: "a", roomId: "1" })).toBe("a::1");
  });
});

describe("runProspectRoomMatches", () => {
  it("remembers today's fitting rooms on the first sweep and texts nothing", async () => {
    const fake = setup();
    const { send, deps } = harness(async () => [listing("old")]);
    expect(await runProspectRoomMatches(fake.db, deps)).toMatchObject({ considered: 1, remembered: 1, texted: 0 });
    expect(send).not.toHaveBeenCalled();
    expect((fake.rows.sms_unassigned_leads![0]!.profile as { roomsSeen: string[] }).roomsSeen).toEqual(["old::old-r1"]);
  });

  it("texts a new fitting room once, from the team's own number, then never again", async () => {
    const fake = setup({ profile: { ...PROFILE, roomsSeen: ["old::old-r1"] } });
    const { send, deps } = harness(async () => [listing("old"), listing("new", 700)]);
    expect(await runProspectRoomMatches(fake.db, deps)).toMatchObject({ texted: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0] as unknown as [unknown, Record<string, string>])[1]!;
    expect(input).toMatchObject({ workspaceId: "ws-a", ownerUserId: "owner-a", toPhone: "+12065550123", idempotencyKey: "prospect-new-room:lead-1" });
    expect(input.body).toContain("A room that fits just opened.");
    expect(input.body).toContain("https://proplane.ai/rent/listings/new");
    expect(fake.rows.sms_unassigned_leads![0]!.profile).toMatchObject({ newRoomTexted: NOW.toISOString() });
    // Another sweep, even with yet another room: the prospect has had their one text.
    await runProspectRoomMatches(fake.db, harness(async () => [listing("old"), listing("new", 700), listing("newer", 650)]).deps);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never offers another team's room", async () => {
    const fake = setup({ profile: { ...PROFILE, roomsSeen: [] } });
    const { send, deps } = harness(async () => [listing("theirs", 500)]);
    await runProspectRoomMatches(fake.db, deps);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not text a room that does not fit what they asked for", async () => {
    const fake = setup({ profile: { ...PROFILE, roomsSeen: [] } });
    const { send, deps } = harness(async () => [listing("new", 2500), listing("new", 800, "Capitol Hill")]);
    await runProspectRoomMatches(fake.db, deps);
    expect(send).not.toHaveBeenCalled();
  });

  it("two overlapping sweeps send one text", async () => {
    const fake = setup({ profile: { ...PROFILE, roomsSeen: [] } });
    const { send, deps } = harness(async () => [listing("new", 700)]);
    await Promise.all([runProspectRoomMatches(fake.db, deps), runProspectRoomMatches(fake.db, deps)]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("respects a STOP: never retried", async () => {
    const fake = setup({ profile: { ...PROFILE, roomsSeen: [] } });
    const refused = vi.fn(async () => ({ ok: false as const, reason: "opted_out" as const }));
    const { deps } = harness(async () => [listing("new", 700)], refused as never);
    await runProspectRoomMatches(fake.db, deps);
    await runProspectRoomMatches(fake.db, deps);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("hands a prospect back to a later sweep when the text fails for another reason", async () => {
    const fake = setup({ profile: { ...PROFILE, roomsSeen: [] } });
    const failing = vi.fn(async () => ({ ok: false as const, reason: "provider_error" as const }));
    await runProspectRoomMatches(fake.db, harness(async () => [listing("new", 700)], failing as never).deps);
    expect((fake.rows.sms_unassigned_leads![0]!.profile as { newRoomTexted?: string }).newRoomTexted).toBeUndefined();
    const ok = harness(async () => [listing("new", 700)]);
    await runProspectRoomMatches(fake.db, ok.deps);
    expect(ok.send).toHaveBeenCalledTimes(1);
  });

  it("is off outside the shared line and in quiet hours", async () => {
    const send = vi.fn();
    expect(await runProspectRoomMatches(setup({ mode: "per_workspace" }).db, harness(async () => [], send as never).deps)).toMatchObject({ skipped: "not_shared_mode" });
    const quiet = { ...harness(async () => []).deps, now: () => new Date("2026-10-20T08:00:00Z") }; // 1am Pacific
    expect(await runProspectRoomMatches(setup().db, quiet)).toMatchObject({ skipped: "quiet_hours" });
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves a prospect with nothing to match on, an unassigned lead, and an already-texted prospect alone", async () => {
    const leads = [
      { id: "a", phone_key: "2065550001", status: "assigned", assigned_workspace_id: "ws-a", profile: { stage: "assigned" }, last_inbound_at: ago(HOUR), updated_at: ago(HOUR) },
      { id: "b", phone_key: "2065550002", status: "open", assigned_workspace_id: null, profile: PROFILE, last_inbound_at: ago(HOUR), updated_at: ago(HOUR) },
      { id: "c", phone_key: "2065550003", status: "assigned", assigned_workspace_id: "ws-a", profile: { ...PROFILE, roomsSeen: [], newRoomTexted: ago(HOUR) }, last_inbound_at: ago(HOUR), updated_at: ago(HOUR) },
    ];
    const { send, deps } = harness(async () => [listing("new", 700)]);
    expect(await runProspectRoomMatches(setup({ leads }).db, deps)).toMatchObject({ considered: 0, texted: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
