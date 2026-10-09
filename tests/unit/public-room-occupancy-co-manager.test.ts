/**
 * The public room picker scopes by PROPERTY, not by the owner's user id: a
 * resident a co-manager added still holds the room, and a manager's closed
 * dates (`room_date_block`) hold it too. The payload stays an allowlist of
 * room + date spans.
 */
import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";

function listing() {
  const submission = createDefaultListingSubmission();
  submission.rooms = [
    { ...submission.rooms[0]!, id: "room-a", name: "Room A", occupancyCapacity: 1 },
    { ...submission.rooms[0]!, id: "room-b", name: "Room B", occupancyCapacity: 1 },
  ];
  return { id: "home-1", submission };
}

function fakeDb(
  submission: ReturnType<typeof listing>["submission"],
  tables: { applications?: unknown[]; blocks?: unknown[] },
  seen: { appFilters: string[]; appManagerFilter: boolean },
) {
  return {
    from(table: string) {
      const query = {
        select() { return this; },
        in(column: string) {
          if (table === "manager_application_records" && column === "manager_user_id") seen.appManagerFilter = true;
          return this;
        },
        eq() { return this; },
        or(expression: string) {
          seen.appFilters.push(expression);
          return this;
        },
        order() { return this; },
        range(start: number) {
          const rows =
            table === "manager_application_records" ? tables.applications
              : table === "portal_schedule_records" ? tables.blocks
                : [];
          return Promise.resolve({ data: (rows ?? []).slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "manager_property_records"
            ? [{ id: "home-1", manager_user_id: "owner-1", property_data: { listingSubmission: submission } }]
            : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

describe("public room occupancy reads by property", () => {
  it("counts an approved resident a co-manager added (different manager_user_id)", async () => {
    const { id, submission } = listing();
    const seen = { appFilters: [] as string[], appManagerFilter: false };
    const db = fakeDb(
      submission,
      {
        applications: [
          {
            id: "AXIS-CO1",
            manager_user_id: "co-manager-9",
            assigned: "home-1",
            choice: "home-1::room-a",
            manually_added: "true",
            manual_start: "2026-09-24",
            manual_end: "2026-12-31",
          },
        ],
      },
      seen,
    );
    const rooms = await loadPublicRoomOccupancy(db, [{ id, listingSubmission: submission }], "owner-1");
    expect(seen.appManagerFilter).toBe(false);
    expect(seen.appFilters[0]).toContain("home-1");
    expect(rooms.find((room) => room.roomChoice === "home-1::room-a")?.spans).toEqual([
      { start: "2026-09-24", end: "2026-12-31", count: 1 },
    ]);
    expect(rooms.find((room) => room.roomChoice === "home-1::room-b")?.spans).toEqual([]);
  });

  it("treats a room-specific block as unavailable for that room only, and a roomless block as the whole property", async () => {
    const { id, submission } = listing();
    const seen = { appFilters: [] as string[], appManagerFilter: false };
    const db = fakeDb(
      submission,
      {
        blocks: [
          { id: "b1", property_id: "home-1", row_data: { roomId: "room-a", checkIn: "2026-11-01", checkOut: "2026-11-05", resident: "never exposed" } },
          { id: "b2", property_id: "home-1", row_data: { roomId: "", checkIn: "2026-12-10", checkOut: "2026-12-12" } },
          { id: "b3", property_id: "home-1", row_data: { roomId: "room-b", checkIn: "2027-01-01", checkOut: "2027-01-03", bookingStatus: "cancelled" } },
        ],
      },
      seen,
    );
    const rooms = await loadPublicRoomOccupancy(db, [{ id, listingSubmission: submission }], "owner-1");
    const a = rooms.find((room) => room.roomChoice === "home-1::room-a")!;
    const b = rooms.find((room) => room.roomChoice === "home-1::room-b")!;
    // Check-out is exclusive: Nov 1-5 closes the nights of Nov 1-4.
    expect(a.spans).toEqual([
      { start: "2026-11-01", end: "2026-11-04", count: 1 },
      { start: "2026-12-10", end: "2026-12-11", count: 1 },
    ]);
    expect(b.spans).toEqual([{ start: "2026-12-10", end: "2026-12-11", count: 1 }]);
  });

  it("exposes only room + date spans: no resident or block fields leave the loader", async () => {
    const { id, submission } = listing();
    const seen = { appFilters: [] as string[], appManagerFilter: false };
    const db = fakeDb(
      submission,
      {
        applications: [{ id: "AXIS-CO1", manager_user_id: "co", assigned: "home-1", choice: "home-1::room-a", manually_added: "true", manual_start: "2026-09-24", name: "Secret Person", email: "secret@example.test" }],
        blocks: [{ id: "b1", property_id: "home-1", row_data: { roomId: "room-a", checkIn: "2026-11-01", checkOut: "2026-11-05", residentName: "Secret Person", residentEmail: "secret@example.test" } }],
      },
      seen,
    );
    const rooms = await loadPublicRoomOccupancy(db, [{ id, listingSubmission: submission }], "owner-1");
    const json = JSON.stringify(rooms);
    expect(json).not.toContain("Secret");
    expect(json).not.toContain("secret@");
    for (const room of rooms) expect(Object.keys(room).sort()).toEqual(["roomChoice", "spans"]);
  });
});
