import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { occupancyBlockEntries, occupancySnapshotForManager } from "@/lib/occupancy/snapshot.server";

/**
 * A manager closes a room for painting and mentions the Airbnb code in the reason
 * ("Painting after Airbnb HMABC12345"). The closure must stay a closure through the REAL server
 * converter: with `blockKind` dropped, the HM-note fallback linked it to that reservation, covered
 * the real guest on the same nights, and the in-house count fell to 0.
 */
const OWNER = "owner-1";
const HOUSE = "maple-1";
const ROOM = "room-1";
const CODE = "HMABC12345";

function listing() {
  const submission = createDefaultListingSubmission();
  submission.rentalStyle = "rooms";
  submission.rooms = [{ ...submission.rooms[0]!, id: ROOM, name: "Bedroom A", occupancyCapacity: 1 }];
  return submission;
}

const closureRow = {
  id: "block-closure-1",
  property_id: HOUSE,
  row_data: {
    id: "block-closure-1",
    propertyId: HOUSE,
    roomId: ROOM,
    blockKind: "closed",
    reason: `Painting after Airbnb ${CODE}`,
    checkIn: "2026-10-10",
    checkOut: "2026-10-13",
    bookingStatus: "confirmed",
    createdAt: "2026-10-01T00:00:00.000Z",
  },
};

const connectionRow = {
  id: "conn-1",
  manager_user_id: OWNER,
  property_id: HOUSE,
  room_id: ROOM,
  provider: "airbnb",
  label: "Airbnb",
  import_url: "https://www.airbnb.com/calendar/ical/1.ics?s=x",
  export_token: "tok-1",
  last_synced_at: null,
  last_error: null,
  export_last_fetched_at: null,
  created_at: "2026-09-01T00:00:00.000Z",
  // Airbnb's "Reserved" range: first and last night, inclusive.
  imported_ranges: [{ id: "uid-1", sourceUid: "uid-1", summary: "Reserved", start: "2026-10-10", end: "2026-10-12", reservationCode: CODE }],
};

function fakeDb(submission: ReturnType<typeof listing>) {
  return {
    from(table: string) {
      const rows = (): unknown[] => {
        if (table === "manager_property_records") return [{ id: HOUSE, manager_user_id: OWNER, property_data: { buildingName: "Maple Duplex", listingSubmission: submission } }];
        if (table === "external_calendar_connections") return [connectionRow];
        if (table === "portal_schedule_records") return [closureRow];
        return [];
      };
      const query = {
        select() { return this; },
        in() { return this; },
        eq() { return this; },
        neq() { return this; },
        or() { return this; },
        is() { return this; },
        like() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle() {
          return Promise.resolve({ data: table === "manager_property_records" ? rows()[0] : null, error: null });
        },
        range(start: number) {
          return Promise.resolve({ data: rows().slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

describe("a closure with an Airbnb HM code in its reason, through the real server path", () => {
  it("the server converter keeps blockKind closed on the closure entry", async () => {
    const { typed } = await occupancyBlockEntries(fakeDb(listing()), [HOUSE], {
      properties: [{ id: HOUSE, label: "Maple Duplex", entireHomeListing: false }],
      roomLabelForId: () => "Bedroom A",
    } as never);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatchObject({ blockId: "block-closure-1", blockKind: "closed", reason: `Painting after Airbnb ${CODE}` });
  });

  it("is never linked to the reservation: the Airbnb guest still counts a night inside the range", async () => {
    const result = await occupancySnapshotForManager(fakeDb(listing()), OWNER, {
      propertyIds: [HOUSE],
      from: "2026-10-09",
      to: "2026-10-14",
      days: ["2026-10-11"],
    });

    // Both the closure and the Airbnb reservation are drawn: the closure did not cover the guest.
    expect(result.stays).toHaveLength(2);
    const guest = result.stays.find((stay) => stay.name.startsWith("Airbnb"));
    expect(guest).toMatchObject({ roomId: ROOM, start: "2026-10-10", end: "2026-10-12" });

    const day = result.days[0]!;
    expect(day.dayKey).toBe("2026-10-11");
    expect(day.inHouse).toBe(1);
  });
});
