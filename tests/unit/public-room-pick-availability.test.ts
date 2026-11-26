import { describe, expect, it } from "vitest";
import { publicRoomPick, publicRoomPickFromRows } from "@/lib/public-room-pick-availability";
import { prospectContactMayPrefill } from "@/lib/prospect-contact-prefill";
import { roomAvailabilityDisplay } from "@/lib/public-listing-available-count";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

const TODAY = "2026-11-23";
const HOUSE = "house-5257";

// The 5257 shape from the Nov 23 QA: one open room, rooms opening later, rooms leased into 2027, closed rooms.
const rooms = [
  { id: "r1", name: "Room 1", availability: "Not available" },
  { id: "r2", name: "Room 2", availability: "Not available" },
  { id: "r3", name: "Room 3", availability: "Available now" },
  { id: "r4", name: "Room 4", availability: "Available now" },
  { id: "r5", name: "Room 5", availability: "Available now" },
  { id: "r7", name: "Room 7", availability: "Available now" },
  { id: "r8", name: "Room 8", availability: "Available now", moveInAvailableDate: "2028-03-01" },
];

const occupancy: PublicRoomOccupancy[] = [
  { roomChoice: `${HOUSE}::r3`, spans: [{ start: "2026-01-01", end: "2027-11-24", count: 1 }] }, // leased far out
  { roomChoice: `${HOUSE}::r4`, spans: [{ start: "2026-01-01", end: "2026-12-14", count: 1 }] }, // frees in 3 weeks
  { roomChoice: `${HOUSE}::r5`, spans: [{ start: "2026-01-01", end: "2027-01-31", count: 1 }] }, // frees in ~70 days: the listing says "Leased until"
];

describe("publicRoomPick", () => {
  it("an open room is open now, tourable and applicable", () => {
    const pick = publicRoomPickFromRows(rooms[3], [], HOUSE, TODAY);
    expect(pick.label).toBe("Open now");
    expect(pick.availableFrom).toBe(TODAY);
    expect(pick.tourable).toBe(true);
    expect(pick.applicable).toBe(true);
  });

  it("a room leased past the soon window is neither tourable nor applicable", () => {
    const pick = publicRoomPickFromRows(rooms[2], occupancy, HOUSE, TODAY);
    expect(pick.status.kind).toBe("leased");
    expect(pick.label).toMatch(/^Leased until/);
    expect(pick.availableFrom).toBeNull();
    expect(pick.tourable).toBe(false);
    expect(pick.applicable).toBe(false);
  });

  it("a room closed with no end date is excluded", () => {
    const pick = publicRoomPickFromRows(rooms[0], occupancy, HOUSE, TODAY);
    expect(pick.label).toBe("Not available");
    expect(pick.tourable).toBe(false);
    expect(pick.applicable).toBe(false);
  });

  it("a room freeing inside the window is tourable and carries its real date", () => {
    const pick = publicRoomPickFromRows(rooms[3], occupancy, HOUSE, TODAY);
    expect(pick.status.kind).toBe("soon");
    expect(pick.availableFrom).toBe("2026-12-15");
    expect(pick.label).toMatch(/^Opens /);
    expect(pick.tourable).toBe(true);
    expect(pick.applicable).toBe(true);
  });

  it("a vacant room with its own far opening date is applicable but not tourable", () => {
    const pick = publicRoomPickFromRows(rooms[6], occupancy, HOUSE, TODAY);
    expect(pick.status.kind).toBe("soon");
    expect(pick.availableFrom).toBe("2028-03-01");
    expect(pick.applicable).toBe(true);
    expect(pick.tourable).toBe(false);
  });

  it("matches the listing's own wording for every room", () => {
    for (const room of rooms) {
      const display = roomAvailabilityDisplay(
        { ...room, occupancyCapacity: 1 },
        { rows: occupancy, loading: false, failed: false },
        TODAY,
        HOUSE,
      );
      expect(publicRoomPickFromRows(room, occupancy, HOUSE, TODAY).label).toBe(display?.text);
    }
  });

  it("works from bare spans", () => {
    expect(publicRoomPick(rooms[3], [], TODAY).label).toBe("Open now");
  });
});

describe("one house's spans only", () => {
  it("never reads another house's spans for the same room id", () => {
    const rows: PublicRoomOccupancy[] = [
      ...occupancy,
      { roomChoice: "other-house::r4", spans: [{ start: "2026-01-01", end: null, count: 1 }] },
    ];
    expect(publicRoomPickFromRows(rooms[3], rows, HOUSE, TODAY).tourable).toBe(true);
  });
});

describe("prospectContactMayPrefill", () => {
  it("never pre-fills a manager, admin or vendor identity", () => {
    expect(prospectContactMayPrefill(["manager"])).toBe(false);
    expect(prospectContactMayPrefill(["resident", "admin"])).toBe(false);
    expect(prospectContactMayPrefill(["vendor"])).toBe(false);
  });

  it("pre-fills a resident or a prospect with no role", () => {
    expect(prospectContactMayPrefill(["resident"])).toBe(true);
    expect(prospectContactMayPrefill([])).toBe(true);
  });
});
