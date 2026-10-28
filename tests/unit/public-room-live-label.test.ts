// Plan channels-sync-1027, BUG 1 + D1: the public availability label comes from live spans, never from the saved string.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MockProperty } from "@/data/types";
import { applyLiveRoomAvailability } from "@/lib/public-room-live-label";
import { PUBLIC_SOON_WINDOW_DAYS, publicRoomStatus } from "@/lib/room-availability";
import { roomAvailabilityDisplay } from "@/lib/public-listing-available-count";
import { roomHiddenFromBrowse } from "@/lib/room-listings-catalog";

const TODAY = "2026-10-27";
const day = (offset: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

describe("publicRoomStatus (D1)", () => {
  it("a vacant room is Available now", () => {
    expect(publicRoomStatus({ occupancyCapacity: 1 }, [], TODAY)).toEqual({ kind: "now", text: "Available now" });
  });

  it("a leased room never says Available now: it reads Leased until the last day it is held", () => {
    const status = publicRoomStatus({ occupancyCapacity: 1 }, [{ start: "2026-09-01", end: "2027-08-31", count: 1 }], TODAY);
    expect(status.kind).toBe("leased");
    expect(status.text).toBe("Leased until Aug 31, 2027");
    expect(status.text).not.toMatch(/available now/i);
  });

  it("a room freeing in 10 days reads Available <date after the lease>", () => {
    const status = publicRoomStatus({ occupancyCapacity: 1 }, [{ start: "2026-09-01", end: day(9), count: 1 }], TODAY);
    expect(status).toEqual({ kind: "soon", text: "Available Nov 6", date: day(10) });
  });

  it("the window is 60 days: day 60 is Available, day 61 is Leased until", () => {
    const frees = (offset: number) => publicRoomStatus({ occupancyCapacity: 1 }, [{ start: "2026-09-01", end: day(offset - 1), count: 1 }], TODAY);
    expect(PUBLIC_SOON_WINDOW_DAYS).toBe(60);
    expect(frees(60).kind).toBe("soon");
    expect(frees(61).kind).toBe("leased");
  });

  it("a room closed with no end date is Not available, never a date", () => {
    expect(publicRoomStatus({ occupancyCapacity: 1 }, [{ start: "2026-09-18", end: null, count: 1 }], TODAY)).toEqual({ kind: "closed", text: "Not available" });
  });

  it("a vacant room with its own opening date is Available <date>, however far out, never Leased", () => {
    const status = publicRoomStatus({ occupancyCapacity: 1, moveInAvailableDate: "2027-03-01" }, [], TODAY);
    expect(status.kind).toBe("soon");
    expect(status.text).toBe("Available Mar 1, 2027");
  });

  it("a shared room with a free bed is Available now", () => {
    expect(publicRoomStatus({ occupancyCapacity: 2 }, [{ start: "2026-09-01", end: null, count: 1 }], TODAY).kind).toBe("now");
  });
});

describe("applyLiveRoomAvailability", () => {
  const property = (rooms: Array<Record<string, unknown>>): MockProperty =>
    ({ id: "p1", available: "Available now", listingSubmission: { v: 1, rooms } }) as unknown as MockProperty;
  const rooms = [
    { id: "leased", name: "Room 1", availability: "Available now", occupancyCapacity: 1 },
    { id: "vacant", name: "Room 2", availability: "Unavailable (occupied)", occupancyCapacity: 1 },
    { id: "soon", name: "Room 3", availability: "Available now", occupancyCapacity: 1 },
  ];
  const rows = [
    { roomChoice: "p1::leased", spans: [{ start: "2026-09-01", end: "2027-08-31", count: 1 }] },
    { roomChoice: "p1::vacant", spans: [] },
    { roomChoice: "p1::soon", spans: [{ start: "2026-09-01", end: day(9), count: 1 }] },
  ];

  it("replaces every saved label with the live one, in both directions", () => {
    const [out] = applyLiveRoomAvailability([property(rooms)], rows, TODAY);
    const labels = Object.fromEntries((out!.listingSubmission!.rooms as Array<{ id: string; availability: string }>).map((room) => [room.id, room.availability]));
    expect(labels).toEqual({ leased: "Leased until Aug 31, 2027", vacant: "Available now", soon: "Available Nov 6" });
  });

  it("the house line follows its rooms", () => {
    expect(applyLiveRoomAvailability([property(rooms)], rows, TODAY)[0]!.available).toBe("Available now");
    const noneOpen = applyLiveRoomAvailability([property([rooms[0]!])], [rows[0]!], TODAY)[0]!;
    expect(noneOpen.available).toBe("Not available");
  });

  it("leaves the listing alone when the occupancy read failed, so a saved label is never passed off as verified", () => {
    const listing = property(rooms);
    expect(applyLiveRoomAvailability([listing], null, TODAY)[0]).toBe(listing);
  });

  it("keeps the saved label for a room the snapshot never saw", () => {
    const [out] = applyLiveRoomAvailability([property(rooms)], [rows[0]!], TODAY);
    const byId = Object.fromEntries((out!.listingSubmission!.rooms as Array<{ id: string; availability: string }>).map((room) => [room.id, room.availability]));
    expect(byId.vacant).toBe("Unavailable (occupied)");
  });
});

describe("the listing page and the browse card agree with the label", () => {
  const room = { id: "r1", availability: "Leased until Aug 31, 2027", occupancyCapacity: 1 };
  const rowsFor = (spans: Array<{ start: string; end: string | null; count: number }>) => ({ rows: [{ roomChoice: "p::r1", spans }], loading: false, failed: false });

  it("a catalog label that is itself derived never overrides the spans on the listing page", () => {
    // spans now say it frees in 10 days: the saved "Leased until" must not pin the room as unavailable
    const display = roomAvailabilityDisplay(room, rowsFor([{ start: "2026-09-01", end: day(9), count: 1 }]), TODAY, "p");
    expect(display).toEqual({ text: "Available Nov 6", tone: "future" });
  });

  it("a leased room reads Leased until on the listing page", () => {
    const display = roomAvailabilityDisplay(room, rowsFor([{ start: "2026-09-01", end: "2027-08-31", count: 1 }]), TODAY, "p");
    expect(display).toEqual({ text: "Leased until Aug 31, 2027", tone: "unavailable" });
  });

  it("browse hides a room leased past the window and keeps one that frees soon or is open", () => {
    expect(roomHiddenFromBrowse("Leased until Aug 31, 2027")).toBe(true);
    expect(roomHiddenFromBrowse("Not available")).toBe(true);
    expect(roomHiddenFromBrowse("Available Nov 6")).toBe(false);
    expect(roomHiddenFromBrowse("Available now")).toBe(false);
  });
});

describe("source guards", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("every catalog reader goes through the live resolver: getPublicListings applies it and only the occupancy snapshot opts out", () => {
    const catalog = read("src/lib/public-listings.server.ts");
    expect(catalog).toMatch(/applyLiveRoomAvailability\(projected/);
    expect(catalog).toMatch(/opts\?\.liveAvailability === false/);
    const route = read("src/app/api/public/approved-room-occupancy/route.ts");
    expect(route.match(/getPublicListings\(/g)?.length).toBe(route.match(/getPublicListings\(\{ liveAvailability: false \}\)/g)?.length);
  });

  it("the browse card carries the catalog's label for a submission room instead of painting every room Available now", () => {
    expect(read("src/lib/room-listings-catalog.ts")).toMatch(/availability: r\.availability\?\.trim\(\) \|\| "Available now"/);
  });
});
