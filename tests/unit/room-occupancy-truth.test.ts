/**
 * One rule for "is this room occupied on day D" (captain, Oct 11): a resident stay (hand-added,
 * approved and awaiting a signature, or signed), a channel reservation, a room block or the listing's
 * own blocked dates, up to the room's capacity. The dashboard card, the room row, the manager
 * snapshot, the public picker and the bots all read it, so a hand-added resident with no signed lease
 * can no longer read "0 / 9 occupied" in one place and "taken" in another.
 */
import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { roomAvailabilityForRange } from "@/lib/room-availability-range.server";
import { occupancyHoldEntries } from "@/lib/occupancy/snapshot.server";
import { occupancyForDay } from "@/lib/occupancy/snapshot";
import { roomAvailabilityTextFromOccupancy } from "@/lib/property-record-row-facts";
import { dashboardOccupancyFromSnapshot, dashboardOccupancyUrl } from "@/lib/dashboard-occupancy";
import { dashboardPeriods } from "@/lib/dashboard-kpis";
import { occupiedBedSpans } from "@/lib/room-occupancy-rule";

const OWNER = "owner-1";
const CO = "co-manager-9";
const HOUSE = "home-1";
const TODAY = "2026-10-11";

function listing(capacity = 1) {
  const submission = createDefaultListingSubmission();
  submission.rooms = [
    { ...submission.rooms[0]!, id: "room-a", name: "Room A", occupancyCapacity: capacity, moveInAvailableDate: "" },
    { ...submission.rooms[0]!, id: "room-b", name: "Room B", occupancyCapacity: 1, moveInAvailableDate: "" },
  ];
  return { id: HOUSE, submission };
}

type Tables = {
  applications?: unknown[];
  blocks?: unknown[];
  leases?: unknown[];
  calendars?: unknown[];
};

function fakeDb(submission: ReturnType<typeof listing>["submission"], tables: Tables) {
  return {
    from(table: string) {
      const query = {
        select() { return this; },
        in() { return this; },
        eq() { return this; },
        or() { return this; },
        order() { return this; },
        range(start: number) {
          const rows =
            table === "manager_application_records" ? tables.applications
              : table === "portal_schedule_records" ? tables.blocks
                : table === "portal_lease_pipeline_records" ? tables.leases
                  : [];
          return Promise.resolve({ data: (rows ?? []).slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "manager_property_records"
            ? [{ id: HOUSE, manager_user_id: OWNER, property_data: { listingSubmission: submission } }]
            : table === "account_link_invites"
              ? [{ inviter_user_id: OWNER, invitee_user_id: CO, assigned_property_ids: [HOUSE], team_role: "leasing" }]
              : table === "external_calendar_connections"
                ? tables.calendars ?? []
                : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

/** The 15-resident production shape: approved, hand-added, dates only in manualResidentDetails, no signed lease. */
const manualResident = {
  id: "AXIS-MAN1",
  manager_user_id: OWNER,
  assigned: HOUSE,
  choice: `${HOUSE}::room-a`,
  manually_added: "true",
  manual_start: "2026-09-24",
  manual_end: "2026-11-08",
};

async function spansFor(tables: Tables, capacity = 1) {
  const { id, submission } = listing(capacity);
  const rooms = await loadPublicRoomOccupancy(fakeDb(submission, tables), [{ id, listingSubmission: submission }], OWNER);
  return { rooms, a: rooms.find((r) => r.roomChoice === `${HOUSE}::room-a`)!.spans, b: rooms.find((r) => r.roomChoice === `${HOUSE}::room-b`)!.spans };
}

describe("public occupancy follows the one rule", () => {
  it("counts a hand-added resident who has no signed lease", async () => {
    expect((await spansFor({ applications: [manualResident] })).a).toEqual([{ start: "2026-09-24", end: "2026-11-08", count: 1 }]);
  });

  it("counts an approved applicant still waiting on a signature, on the application's lease dates", async () => {
    const approvedUnsigned = { id: "AXIS-APP1", manager_user_id: OWNER, assigned: HOUSE, choice: `${HOUSE}::room-a`, lease_start: "2026-12-01", lease_end: "2027-05-31" };
    expect((await spansFor({ applications: [approvedUnsigned] })).a).toEqual([{ start: "2026-12-01", end: "2027-05-31", count: 1 }]);
  });

  it("never counts a withdrawn application", async () => {
    expect((await spansFor({ applications: [{ ...manualResident, withdrawn: "2026-10-01T00:00:00Z" }] })).a).toEqual([]);
  });

  it("still drops a row a foreign author filed against this house", async () => {
    expect((await spansFor({ applications: [{ ...manualResident, manager_user_id: "stranger" }] })).a).toEqual([]);
  });

  it("counts an executed lease that has no application row", async () => {
    const lease = {
      id: "lease-1",
      manager_user_id: OWNER,
      property_id: HOUSE,
      row_data: {
        axisId: "AXIS-ORPHAN",
        status: "Fully Signed",
        fullySignedAt: "2026-09-01T00:00:00.000Z",
        roomChoice: `${HOUSE}::room-b`,
        application: { leaseStart: "2026-10-01", leaseEnd: "2027-03-31" },
      },
    };
    expect((await spansFor({ leases: [lease] })).b).toEqual([{ start: "2026-10-01", end: "2027-03-31", count: 1 }]);
  });

  it("does not count a lease twice when its application row already holds the room", async () => {
    const lease = {
      id: "lease-2",
      manager_user_id: OWNER,
      property_id: HOUSE,
      row_data: { axisId: "AXIS-MAN1", status: "Fully Signed", fullySignedAt: "2026-09-01T00:00:00.000Z", roomChoice: `${HOUSE}::room-a`, application: { leaseStart: "2026-09-24", leaseEnd: "2026-11-08" } },
    };
    expect((await spansFor({ applications: [manualResident], leases: [lease] }, 2)).a).toEqual([{ start: "2026-09-24", end: "2026-11-08", count: 1 }]);
  });

  it("counts an Airbnb stay covering today and a standalone host block", async () => {
    const calendars = [
      {
        property_id: HOUSE,
        room_id: "room-a",
        imported_ranges: [
          { sourceUid: "res-1", start: "2026-10-09", end: "2026-10-14", summary: "Reserved" },
          { sourceUid: "blk-1", start: "2026-11-01", end: "2026-11-03", summary: "Airbnb (Not available)", hostBlock: true },
        ],
      },
    ];
    expect((await spansFor({ calendars })).a).toEqual([
      { start: "2026-10-09", end: "2026-10-14", count: 1 },
      { start: "2026-11-01", end: "2026-11-03", count: 1 },
    ]);
  });

  it("a host block that merely echoes a resident is not a second occupant (shared room keeps its free bed)", async () => {
    const calendars = [
      { property_id: HOUSE, room_id: "room-a", imported_ranges: [{ sourceUid: "echo", start: "2026-10-01", end: "2026-10-20", summary: "Airbnb (Not available)", hostBlock: true }] },
    ];
    const { a } = await spansFor({ applications: [manualResident], calendars }, 2);
    // Inside the resident's stay the echo adds nothing; only its days past the stay (Nov 9 on) would, and it ends before.
    expect(a).toEqual([{ start: "2026-09-24", end: "2026-11-08", count: 1 }]);
  });

  it("a host block that runs past the resident still closes the days the resident does not cover", async () => {
    const calendars = [
      { property_id: HOUSE, room_id: "room-a", imported_ranges: [{ sourceUid: "long", start: "2026-11-01", end: "2026-11-12", summary: "Airbnb (Not available)", hostBlock: true }] },
    ];
    const { a } = await spansFor({ applications: [manualResident], calendars }, 2);
    expect(a).toEqual([
      { start: "2026-09-24", end: "2026-11-08", count: 1 },
      { start: "2026-11-09", end: "2026-11-12", count: 1 },
    ]);
  });

  it("counts the listing's own blocked dates", async () => {
    const { id, submission } = listing();
    submission.rooms[1]!.manualUnavailableRanges = [{ id: "unavail-1", start: "2026-10-20", end: "2026-10-25" }];
    const rooms = await loadPublicRoomOccupancy(fakeDb(submission, {}), [{ id, listingSubmission: submission }], OWNER);
    expect(rooms.find((r) => r.roomChoice === `${HOUSE}::room-b`)!.spans).toEqual([{ start: "2026-10-20", end: "2026-10-25", count: 1 }]);
  });

  it("publishes dates and counts only, never a name or an email", async () => {
    const named = { ...manualResident, name: "Secret Person", email: "secret@example.test" };
    const { rooms } = await spansFor({ applications: [named] });
    const json = JSON.stringify(rooms);
    expect(json).not.toContain("Secret");
    expect(json).not.toContain("secret@");
    for (const room of rooms) expect(Object.keys(room).sort()).toEqual(["roomChoice", "spans"]);
  });
});

describe("check_room_availability answers from the same spans", () => {
  async function answer(tables: Tables, moveIn: string, moveOut: string) {
    const { id, submission } = listing();
    const result = await roomAvailabilityForRange(
      { propertyId: id, roomId: "room-a", moveIn, moveOut },
      { submission, loadOccupancy: () => loadPublicRoomOccupancy(fakeDb(submission, tables), [{ id, listingSubmission: submission }], OWNER) },
    );
    if (!result.ok) throw new Error(result.message);
    return result.rooms[0]!;
  }

  it("a hand-added resident with no lease blocks the room and names the first free night", async () => {
    const room = await answer({ applications: [manualResident] }, "2026-10-15", "2026-11-01");
    expect(room.available).toBe(false);
    expect(room.nextAvailableFrom).toBe("2026-11-09");
  });

  it("a future move-in leaves the room available until that date", async () => {
    const future = { ...manualResident, manual_start: "2026-12-01", manual_end: "2027-05-31" };
    const room = await answer({ applications: [future] }, "2026-10-15", "2026-11-15");
    expect(room.available).toBe(true);
    const open = await roomAvailabilityForRange(
      { propertyId: HOUSE, roomId: "room-a", moveIn: "2026-10-15" },
      { submission: listing().submission, loadOccupancy: () => loadPublicRoomOccupancy(fakeDb(listing().submission, { applications: [future] }), [{ id: HOUSE, listingSubmission: listing().submission }], OWNER) },
    );
    expect(open.ok && open.rooms[0]!.freeUntil).toBe("2026-12-01");
  });

  it("a past move-out frees the room", async () => {
    const past = { ...manualResident, manual_start: "2026-01-01", manual_end: "2026-06-01" };
    expect((await answer({ applications: [past] }, "2026-10-15", "2026-11-01")).available).toBe(true);
  });
});

describe("the manager snapshot reads the same holds", () => {
  const meta = { properties: [{ id: "p1", label: "House", entireHomeListing: false }], roomLabelForId: (_p: string, r: string) => `Room ${r}` };
  const row = (id: string, extra: Record<string, unknown> = {}, rowData: Record<string, unknown> = {}) => ({
    id,
    property_id: "p1",
    assigned_property_id: "p1",
    manager_user_id: "owner-1",
    row_data: { bucket: "approved", assignedRoomChoice: "p1::r1", manualResidentDetails: { moveInDate: "2026-09-24", moveOutDate: "2026-11-08" }, ...rowData },
    ...extra,
  });
  function db(rows: Record<string, unknown>[]) {
    const from = (table: string) => {
      if (table === "manager_property_records") {
        const c = { in: () => c, select: () => c, then: (r: (v: unknown) => unknown) => r({ data: [{ id: "p1", manager_user_id: "owner-1" }], error: null }) };
        return c;
      }
      if (table === "account_link_invites") {
        const c = { select: () => c, eq: () => c, in: () => c, then: (r: (v: unknown) => unknown) => r({ data: [], error: null }) };
        return c;
      }
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, in: () => chain, like: () => chain, order: () => chain,
        range: (start: number, end: number) => Promise.resolve({ data: rows.slice(start, end + 1), error: null }),
      };
      return chain;
    };
    return { from } as never;
  }
  const capacities = { bedsTotal: () => 9, roomCapacity: () => 1 };

  it("a hand-added resident with no signed lease occupies a room today", async () => {
    const entries = await occupancyHoldEntries(db([row("AXIS-1")]), ["p1"], [], meta);
    expect(occupancyForDay(entries, TODAY, ["p1"], capacities)).toMatchObject({ occupied: 1, total: 9 });
  });

  it("a withdrawn application holds nothing", async () => {
    const entries = await occupancyHoldEntries(db([row("AXIS-2", {}, { withdrawnAt: "2026-10-01T00:00:00Z" })]), ["p1"], [], meta);
    expect(entries).toEqual([]);
  });

  it("a row that only carries the applicant's first choice still holds that room", async () => {
    const entries = await occupancyHoldEntries(
      db([row("AXIS-3", {}, { assignedRoomChoice: undefined, application: { roomChoice1: "p1::r2", leaseStart: "2026-10-01", leaseEnd: "2027-01-01" }, manualResidentDetails: undefined })]),
      ["p1"],
      [],
      meta,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ roomId: "r2", start: "2026-10-01" });
  });

  it("a future move-in is free until its date and a past move-out is free today", async () => {
    const future = await occupancyHoldEntries(db([row("AXIS-4", {}, { manualResidentDetails: { moveInDate: "2026-12-01", moveOutDate: "2027-05-31" } })]), ["p1"], [], meta);
    expect(occupancyForDay(future, TODAY, ["p1"], capacities).occupied).toBe(0);
    expect(occupancyForDay(future, "2026-12-01", ["p1"], capacities).occupied).toBe(1);
    const past = await occupancyHoldEntries(db([row("AXIS-5", {}, { manualResidentDetails: { moveInDate: "2026-01-01", moveOutDate: "2026-06-01" } })]), ["p1"], [], meta);
    expect(occupancyForDay(past, TODAY, ["p1"], capacities).occupied).toBe(0);
  });
});

describe("the room row text", () => {
  const room = { id: "room-a", manualUnavailableRanges: [], moveInAvailableDate: "", occupancyCapacity: 1 };

  it("says Occupied until the hand-added resident's last day", () => {
    expect(roomAvailabilityTextFromOccupancy(room, [{ roomId: "room-a", start: "2026-09-24", end: "2026-11-08" }], TODAY)).toBe("Occupied until Nov 8, 2026");
  });
  it("says Available now once the resident has moved out, and until a future move-in", () => {
    expect(roomAvailabilityTextFromOccupancy(room, [{ roomId: "room-a", start: "2026-01-01", end: "2026-06-01" }], TODAY)).toBe("Available now");
    expect(roomAvailabilityTextFromOccupancy(room, [{ roomId: "room-a", start: "2026-12-01", end: "2027-05-31" }], TODAY)).toBe("Available now until Nov 30, 2026");
  });
  it("an open-ended stay is just Occupied; an Airbnb stay covering today closes the room", () => {
    expect(roomAvailabilityTextFromOccupancy(room, [{ roomId: "room-a", start: "2026-09-01", end: "2028-10-01", openEnded: true }], TODAY)).toBe("Occupied");
    expect(roomAvailabilityTextFromOccupancy(room, [{ roomId: "room-a", start: "2026-10-09", end: "2026-10-14" }], TODAY)).toBe("Occupied until Oct 14, 2026");
  });
  it("a channel echo on a resident's days is not a second occupant in a shared room", () => {
    const shared = { ...room, occupancyCapacity: 2 };
    const stays = [
      { roomId: "room-a", start: "2026-09-24", end: "2026-11-08" },
      { roomId: "room-a", start: "2026-10-01", end: "2026-10-20", echoable: true },
    ];
    expect(roomAvailabilityTextFromOccupancy(shared, stays, TODAY)).toBe("Available now");
  });
  it("another room's stay does not close this one; a whole-home stay does", () => {
    expect(roomAvailabilityTextFromOccupancy(room, [{ roomId: "room-b", start: "2026-09-24", end: "2026-11-08" }], TODAY)).toBe("Available now");
    expect(roomAvailabilityTextFromOccupancy(room, [{ roomId: "", start: "2026-09-24", end: "2026-11-08" }], TODAY)).toBe("Occupied until Nov 8, 2026");
  });
  it("a room's own earliest move-in date still reads Available from", () => {
    expect(roomAvailabilityTextFromOccupancy({ ...room, moveInAvailableDate: "2026-11-01" }, [], TODAY)).toBe("Available from Nov 1, 2026");
  });
});

describe("occupiedBedSpans", () => {
  it("keeps a standalone echoable closure and drops one fully under another occupant", () => {
    expect(occupiedBedSpans([{ start: "2026-10-01", end: "2026-10-05", echoable: true }])).toEqual([{ start: "2026-10-01", end: "2026-10-05", count: 1 }]);
    expect(
      occupiedBedSpans([
        { start: "2026-10-01", end: "2026-10-10" },
        { start: "2026-10-03", end: "2026-10-05", echoable: true },
      ]),
    ).toEqual([{ start: "2026-10-01", end: "2026-10-10", count: 1 }]);
  });
  it("an open-ended echo under an open-ended resident adds nothing", () => {
    expect(occupiedBedSpans([{ start: "2026-10-01", end: null }, { start: "2026-10-05", end: null, echoable: true }])).toEqual([{ start: "2026-10-01", end: null, count: 1 }]);
  });
});

describe("dashboard occupancy from the snapshot", () => {
  const days = [
    { dayKey: "2026-09-30", occupied: 4, total: 9, checkIns: 0, checkOuts: 0, houses: [] },
    { dayKey: TODAY, occupied: 15, total: 20, checkIns: 0, checkOuts: 0, houses: [{ propertyId: "p1", occupied: 8, total: 9, checkIns: 0, checkOuts: 0 }, { propertyId: "p2", occupied: 7, total: 11, checkIns: 0, checkOuts: 0 }] },
  ];
  it("reads today's occupied rooms per house and the period series", () => {
    const periods = dashboardPeriods("month", new Date(2026, 9, 11, 12).getTime(), 2);
    const shaped = dashboardOccupancyFromSnapshot({ days }, TODAY, periods)!;
    expect(shaped.byProperty.get("p1")).toBe(8);
    expect(shaped.occupiedToday).toBe(15);
    expect(shaped.occupiedByPeriod).toEqual([4, 15]);
  });
  it("a malformed or empty answer is unknown (null), never zero", () => {
    expect(dashboardOccupancyFromSnapshot(null, TODAY, [])).toBeNull();
    expect(dashboardOccupancyFromSnapshot({ days: [] }, TODAY, [])).toBeNull();
  });
  it("asks once per house set, sorted", () => {
    expect(dashboardOccupancyUrl(["b", "a", "a"], TODAY)).toContain("propertyIds=a%2Cb");
  });
});
