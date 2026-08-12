/**
 * The Bookings calendar used to draw ONLY Airbnb-imported ranges, so a room let
 * through PropLane itself read as free — the exact question a manager opens
 * this screen to answer. These are the merge rules behind the fix.
 */
import { describe, expect, it } from "vitest";
import {
  airbnbBookingEntries,
  bookedDayKeyCountInMonth,
  bookingEntriesForDayKey,
  filterBookingEntriesByRoom,
  leaseBookingEntries,
  leaseBookingEntriesForProperties,
  normalizeBookingDateKey,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import type { ManagerChannelBookingProperty } from "@/lib/channel-calendar/types";

const PROPERTY_ID = "mgr-house-1";
const LABEL = "4709A 8th Ave NE";

function leaseOpts(overrides?: Partial<Parameters<typeof leaseBookingEntries>[1]>) {
  return {
    propertyId: PROPERTY_ID,
    propertyLabel: LABEL,
    roomLabelForId: (id: string) => (id === "room-a" ? "Room A" : "Room B"),
    openEndedHorizonKey: "2028-01-01",
    ...overrides,
  };
}

describe("normalizeBookingDateKey", () => {
  it("passes an ISO day through", () => {
    expect(normalizeBookingDateKey("2026-08-14")).toBe("2026-08-14");
  });

  it("converts a US slash date — string comparison would fail on it otherwise", () => {
    expect(normalizeBookingDateKey("8/1/2026")).toBe("2026-08-01");
  });

  it("keeps a bare ISO date on its own local day rather than shifting a day back", () => {
    // `new Date("2026-08-01")` is UTC midnight = Jul 31 in Pacific.
    expect(normalizeBookingDateKey("2026-08-01")).toBe("2026-08-01");
  });

  it("returns empty for junk instead of an Invalid Date key", () => {
    expect(normalizeBookingDateKey("not a date")).toBe("");
    expect(normalizeBookingDateKey("")).toBe("");
    expect(normalizeBookingDateKey(null)).toBe("");
  });
});

describe("leaseBookingEntries", () => {
  const base = {
    propertyId: PROPERTY_ID,
    residentName: "Cv Ponce",
    roomChoice: `${PROPERTY_ID}::room-a`,
    stageLabel: "Signed",
    application: { leaseStart: "2026-08-10", leaseEnd: "2026-08-20" },
  };

  it("turns a lease into a PropLane stay on its own room", () => {
    const [entry] = leaseBookingEntries([base], leaseOpts());
    expect(entry?.source).toBe("proplane");
    expect(entry?.roomId).toBe("room-a");
    expect(entry?.roomLabel).toBe("Room A");
    expect(entry?.summary).toBe("Cv Ponce");
    expect(entry?.statusLabel).toBe("Signed");
    expect(entry?.start).toBe("2026-08-10");
    expect(entry?.end).toBe("2026-08-20");
  });

  it("ignores another house's leases", () => {
    expect(leaseBookingEntries([{ ...base, propertyId: "other" }], leaseOpts())).toHaveLength(0);
  });

  it("a voided lease is not a booking", () => {
    expect(leaseBookingEntries([{ ...base, status: "Voided" }], leaseOpts())).toHaveLength(0);
  });

  it("a lease with no start date is skipped rather than drawn on Invalid Date", () => {
    expect(
      leaseBookingEntries([{ ...base, application: { leaseStart: "" } }], leaseOpts()),
    ).toHaveLength(0);
  });

  it("runs an open-ended lease to the horizon instead of one day", () => {
    const [entry] = leaseBookingEntries(
      [{ ...base, application: { leaseStart: "2026-08-10" } }],
      leaseOpts(),
    );
    expect(entry?.openEnded).toBe(true);
    expect(entry?.end).toBe("2028-01-01");
  });

  it("treats a lease with no room as the whole home", () => {
    const [entry] = leaseBookingEntries([{ ...base, roomChoice: "" }], leaseOpts());
    expect(entry?.roomId).toBe("");
    expect(entry?.roomLabel).toBe("Whole home");
  });
});

describe("merged day lookup", () => {
  const airbnb: ManagerChannelBookingProperty[] = [
    {
      propertyId: PROPERTY_ID,
      propertyLabel: LABEL,
      rooms: [
        {
          connectionId: "c1",
          roomId: "room-b",
          roomLabel: "Room B",
          provider: "airbnb",
          label: null,
          ranges: [{ start: "2026-08-12", end: "2026-08-15", summary: "Reserved (Airbnb)" }],
          lastSyncedAt: null,
          lastError: null,
          hasImportUrl: true,
          exportUrl: "https://prop-lane.space/api/calendar/export/token.ics",
        },
      ],
    },
  ];

  const entries: PropertyBookingEntry[] = [
    ...airbnbBookingEntries(airbnb),
    ...leaseBookingEntries(
      [
        {
          propertyId: PROPERTY_ID,
          residentName: "Cv Ponce",
          roomChoice: `${PROPERTY_ID}::room-a`,
          application: { leaseStart: "2026-08-10", leaseEnd: "2026-08-13" },
        },
      ],
      leaseOpts(),
    ),
  ];

  it("shows both channels on an overlapping day", () => {
    const day = bookingEntriesForDayKey(entries, "2026-08-13");
    expect(day.map((e) => e.source).sort()).toEqual(["airbnb", "proplane"]);
  });

  it("shows the PropLane stay on a day Airbnb has nothing — the old blind spot", () => {
    const day = bookingEntriesForDayKey(entries, "2026-08-10");
    expect(day).toHaveLength(1);
    expect(day[0]?.source).toBe("proplane");
  });

  it("counts every booked day in the month across both sources", () => {
    // PropLane 10–13 plus Airbnb 12–15 = the 10th through the 15th.
    expect(bookedDayKeyCountInMonth(entries, 2026, 7)).toBe(6);
  });

  describe("room filter", () => {
    it("keeps only that room", () => {
      const roomA = filterBookingEntriesByRoom(entries, "room-a");
      expect(roomA.every((e) => e.roomId === "room-a")).toBe(true);
      expect(roomA).toHaveLength(1);
    });

    it("an empty filter means every room", () => {
      expect(filterBookingEntriesByRoom(entries, "")).toHaveLength(entries.length);
    });

    it("a whole-home stay survives a room filter — it occupies that room too", () => {
      const wholeHome = leaseBookingEntries(
        [
          {
            propertyId: PROPERTY_ID,
            residentName: "Whole home guest",
            roomChoice: "",
            application: { leaseStart: "2026-09-01", leaseEnd: "2026-09-05" },
          },
        ],
        leaseOpts(),
      );
      expect(filterBookingEntriesByRoom(wholeHome, "room-a")).toHaveLength(1);
    });
  });
});

/**
 * The portfolio-wide Bookings view scopes to several houses at once. It shipped
 * Airbnb-only while the per-property panel merged both channels, which is the
 * same "a PropLane stay draws as free" defect one level up.
 */
describe("leaseBookingEntriesForProperties", () => {
  const rows = [
    {
      propertyId: PROPERTY_ID,
      residentName: "Ada",
      roomChoice: `${PROPERTY_ID}::room-a`,
      application: { leaseStart: "2026-08-01", leaseEnd: "2026-08-04" },
    },
    {
      propertyId: "mgr-house-2",
      residentName: "Grace",
      roomChoice: "",
      application: { leaseStart: "2026-08-02", leaseEnd: "2026-08-03" },
    },
    {
      propertyId: "mgr-house-3",
      residentName: "Not in scope",
      roomChoice: "",
      application: { leaseStart: "2026-08-02", leaseEnd: "2026-08-03" },
    },
  ];

  const scoped = [
    { id: PROPERTY_ID, label: LABEL },
    { id: "mgr-house-2", label: "Second house" },
  ];

  it("draws stays from every scoped house and none from outside it", () => {
    const entries = leaseBookingEntriesForProperties(rows, {
      properties: scoped,
      openEndedHorizonKey: "2028-01-01",
    });
    expect(entries.map((e) => e.summary).sort()).toEqual(["Ada", "Grace"]);
    expect(entries.every((e) => e.source === "proplane")).toBe(true);
  });

  it("labels each house from its own entry, not the first one", () => {
    const entries = leaseBookingEntriesForProperties(rows, {
      properties: scoped,
      openEndedHorizonKey: "2028-01-01",
    });
    expect(entries.find((e) => e.summary === "Grace")?.propertyLabel).toBe("Second house");
  });

  it("resolves a room label per property, falling back to a neutral one", () => {
    const entries = leaseBookingEntriesForProperties(rows, {
      properties: scoped,
      roomLabelForId: (propertyId, roomId) =>
        propertyId === PROPERTY_ID && roomId === "room-a" ? "Room A" : "Room",
      openEndedHorizonKey: "2028-01-01",
    });
    expect(entries.find((e) => e.summary === "Ada")?.roomLabel).toBe("Room A");
    expect(entries.find((e) => e.summary === "Grace")?.roomLabel).toBe("Whole home");
  });

  it("is empty when nothing is in scope rather than falling back to every house", () => {
    expect(
      leaseBookingEntriesForProperties(rows, { properties: [], openEndedHorizonKey: "2028-01-01" }),
    ).toEqual([]);
  });
});
