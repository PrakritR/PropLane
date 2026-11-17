/**
 * A month-to-month residency with a stale past leaseEnd still holds its room on the public listing:
 * it rolls to today + 365 through `leaseBlockEnd`, and a move-out date still wins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";

const OWNER = "owner-1";
const HOUSE = "home-1";

function fakeDb(submission: unknown, application: Record<string, unknown>) {
  return {
    from(table: string) {
      const query = {
        select() { return this; },
        in() { return this; },
        eq() { return this; },
        or() { return this; },
        order() { return this; },
        range(start: number) {
          const rows = table === "manager_application_records" ? [application] : [];
          return Promise.resolve({ data: rows.slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data =
            table === "manager_property_records"
              ? [{ id: HOUSE, manager_user_id: OWNER, property_data: { listingSubmission: submission } }]
              : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

async function spansFor(application: Record<string, unknown>) {
  const submission = createDefaultListingSubmission();
  submission.rooms = [{ ...submission.rooms[0]!, id: "room-a", name: "Room A", occupancyCapacity: 1 }];
  const rooms = await loadPublicRoomOccupancy(
    fakeDb(submission, { id: "AXIS-MTM1", manager_user_id: OWNER, assigned: HOUSE, choice: `${HOUSE}::room-a`, lease_start: "2025-01-01", ...application }),
    [{ id: HOUSE, listingSubmission: submission }],
    OWNER,
  );
  return rooms.find((room) => room.roomChoice === `${HOUSE}::room-a`)?.spans ?? [];
}

describe("public room occupancy: month-to-month", () => {
  afterEach(() => vi.useRealTimers());

  it("a stale past leaseEnd does not read the room free", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T20:00:00Z"));
    const spans = await spansFor({ lease_end: "2025-12-31", lease_term: "Month-to-Month" });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe("2025-01-01");
    expect(spans[0]!.end! >= "2027-11-01").toBe(true);
  });

  it("a fixed term keeps its own end date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T20:00:00Z"));
    expect(await spansFor({ lease_end: "2025-12-31", lease_term: "12 months" })).toEqual([
      { start: "2025-01-01", end: "2025-12-31", count: 1 },
    ]);
  });

  it("a move-out date wins over the rolling end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T20:00:00Z"));
    expect(await spansFor({ lease_end: "2025-12-31", manual_term: "Month-to-Month", manual_end: "2026-12-15" })).toEqual([
      { start: "2025-01-01", end: "2026-12-15", count: 1 },
    ]);
  });

  it("a withdrawn row holds nothing", async () => {
    expect(await spansFor({ lease_term: "Month-to-Month", withdrawn: "2026-01-01T00:00:00Z" })).toEqual([]);
  });
});
