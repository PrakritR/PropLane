import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ publicListings: vi.fn(), occupancy: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.publicListings }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));
vi.mock("@/lib/public-room-occupancy.server", () => ({ loadPublicRoomOccupancy: mocks.occupancy }));

import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  __resetLeasingCatalogCache,
  __resetSmsOccupancyCache,
  checkedAvailabilityForListing,
  listLiveListingsTool,
} from "@/lib/tools/domains/leasing-sms";
import { CHANNEL_CONFIRM_LATER_REPLY, enforceCheckedAvailability } from "@/lib/agent/channel-reply-policy";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const submission = createDefaultListingSubmission();
submission.rooms = [
  { id: "r5", name: "Room 5", monthlyRent: 1100, availability: "Available now" },
  { id: "r6", name: "Room 6", monthlyRent: 1150, availability: "Available now" },
] as typeof submission.rooms;
const listing = {
  id: "p5257", status: "live", title: "5257 Brooklyn Ave", address: "5257 Brooklyn Ave", managerUserId: OWNER, listingSubmission: submission,
};
const ctx = () => ({
  landlordId: OWNER,
  db: {},
  leasingScope: { crossCatalog: true, prospectPhoneE164: "", prospectEmail: null, channel: "email", workNumber: null, sessionId: "s", currentInboundText: "" },
}) as never;

type Room = { name: string; publishedAvailability: string | null; currentAvailability: string | null; currentAvailabilityVerified: boolean; freeNow: boolean | null; freeFrom: string | null; availabilityNote?: string };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T19:00:00.000Z"));
  __resetLeasingCatalogCache();
  __resetSmsOccupancyCache();
  vi.clearAllMocks();
  mocks.publicListings.mockResolvedValue([listing]);
});
afterEach(() => vi.useRealTimers());

describe("list_live_listings answers from the CHECKED calendar", () => {
  it("returns the exact free date for an occupied room and 'free now' for an open one, never the saved label", async () => {
    // Room 6 is held by a channel booking through Oct 31; Room 5 has no occupancy at all.
    mocks.occupancy.mockResolvedValue([
      { roomChoice: "p5257::r6", spans: [{ start: "2026-09-01", end: "2026-10-31", count: 1 }] },
      { roomChoice: "p5257::r5", spans: [] },
    ]);
    const result = (await listLiveListingsTool.handler(ctx(), { query: "5257 Brooklyn" })) as { listings: { rooms: Room[] }[] };
    const rooms = result.listings[0]!.rooms;
    expect(rooms.length).toBe(2);
    const room6 = rooms.find((r) => r.name === "Room 6")!;
    const room5 = rooms.find((r) => r.name === "Room 5")!;
    expect(room6).toMatchObject({ currentAvailabilityVerified: true, freeNow: false, freeFrom: "2026-11-01", publishedAvailability: null });
    expect(room6.currentAvailability).toMatch(/Unavailable/);
    expect(room5).toMatchObject({ currentAvailabilityVerified: true, freeNow: true, freeFrom: "2026-10-27", publishedAvailability: null });
    // The saved "Available now" on Room 6 is stale and appears nowhere on a verified room.
    expect(JSON.stringify(room6)).not.toContain("Available now");
  });

  it("a failed occupancy read is NOT 'available': unverified, with the confirm-later note", async () => {
    mocks.occupancy.mockRejectedValue(new Error("db down"));
    const result = (await listLiveListingsTool.handler(ctx(), { query: "5257 Brooklyn" })) as { listings: { rooms: Room[] }[] };
    expect(result.listings[0]!.rooms.length).toBe(2);
    for (const room of result.listings[0]!.rooms) {
      expect(room.currentAvailabilityVerified).toBe(false);
      expect(room.freeNow).toBeNull();
      expect(room.freeFrom).toBeNull();
      expect(room.currentAvailability).toBeNull();
      expect(room.availabilityNote).toMatch(/could not be verified/i);
      expect(room.availabilityNote).toMatch(/never say/i);
    }
  });

  it("the helper itself degrades to an empty map on a failed read", async () => {
    mocks.occupancy.mockRejectedValue(new Error("db down"));
    const rec = { id: "p5257", status: "live", property_data: listing, row_data: null } as never;
    expect(listing.listingSubmission.v).toBe(1);
    expect((await checkedAvailabilityForListing(rec, undefined)).size).toBe(0);
  });

  it("an assistant that nonetheless claims availability after a failed read is replaced with the confirm-later text", async () => {
    // The list call itself SUCCEEDS on a failed occupancy read - every room just comes back unverified - so the
    // post-check has to read the rooms it returned, not the fact that it was called.
    mocks.occupancy.mockRejectedValue(new Error("db down"));
    const listed = await listLiveListingsTool.handler(ctx(), { query: "5257 Brooklyn" });
    const out = enforceCheckedAvailability({
      reply: "Room 6 is available from November 1.",
      toolEvidence: [{ tool: "list_live_listings", output: listed }],
    });
    expect(out).toEqual({ reply: CHANNEL_CONFIRM_LATER_REPLY, replaced: true });
  });

  it("a verified room's availability stands as written", async () => {
    mocks.occupancy.mockResolvedValue([
      { roomChoice: "p5257::r6", spans: [{ start: "2026-09-01", end: "2026-10-31", count: 1 }] },
      { roomChoice: "p5257::r5", spans: [] },
    ]);
    const listed = await listLiveListingsTool.handler(ctx(), { query: "5257 Brooklyn" });
    const reply = "Room 6 is available from November 1.";
    expect(enforceCheckedAvailability({ reply, toolEvidence: [{ tool: "list_live_listings", output: listed }] })).toEqual({ reply, replaced: false });
  });
});
