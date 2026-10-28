// Plan channels-sync-1027, BUG 3: sync-all runs rooms of one house at once; the listing write must not lose a room's ranges.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ListingSubmissionConflictError, updateListingSubmission } from "@/lib/channel-calendar/sync.server";

type Row = { id: string; manager_user_id: string; property_data: { id: string; listingSubmission: { v: 1; rooms: Array<{ id: string; ranges: string[] }> } }; row_data: null; occupancy_revision: number | null };

/** A filter-honouring stand-in for `manager_property_records`: `.eq("occupancy_revision", n)` on an update only lands on a matching row. */
function fakeDb(row: Row, opts: { alwaysMiss?: boolean } = {}) {
  const writes: Array<{ revision: number | null; viaCas: boolean }> = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          // The snapshot is taken when the read is ISSUED, like a real round trip that returns what was committed then.
          maybeSingle: () => {
            const snapshot = JSON.parse(JSON.stringify(row)) as Row;
            return new Promise((resolve) => setTimeout(() => resolve({ data: snapshot, error: null }), 0));
          },
        }),
      }),
      update: (payload: { property_data: Row["property_data"]; occupancy_revision?: number }) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
          select: () => chain,
          then: (resolve: (value: unknown) => void) => {
            const expected = filters.find(([column]) => column === "occupancy_revision")?.[1] as number | undefined;
            const matches = !opts.alwaysMiss && (expected === undefined || row.occupancy_revision === expected);
            if (matches) {
              row.property_data = payload.property_data;
              if (payload.occupancy_revision !== undefined) row.occupancy_revision = payload.occupancy_revision;
              writes.push({ revision: payload.occupancy_revision ?? null, viaCas: expected !== undefined });
            }
            resolve({ data: matches ? [{ id: row.id }] : [], error: null });
          },
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { db, writes };
}

const house = (revision: number | null): Row => ({
  id: "prop-1",
  manager_user_id: "owner",
  occupancy_revision: revision,
  row_data: null,
  property_data: { id: "prop-1", listingSubmission: { v: 1, rooms: [{ id: "r1", ranges: [] }, { id: "r2", ranges: [] }] } },
});

const addRange = (roomId: string, range: string) => (submission: Row["property_data"]["listingSubmission"]) =>
  ({ ...submission, rooms: submission.rooms.map((room) => (room.id === roomId ? { ...room, ranges: [...room.ranges, range] } : room)) });

describe("updateListingSubmission is a compare-and-set on occupancy_revision", () => {
  it("two rooms synced at once both land: no lost write", async () => {
    const row = house(7);
    const { db, writes } = fakeDb(row);
    await Promise.all([
      updateListingSubmission(db, "prop-1", addRange("r1", "oct-28")),
      updateListingSubmission(db, "prop-1", addRange("r2", "nov-02")),
    ]);
    const byRoom = Object.fromEntries(row.property_data.listingSubmission.rooms.map((room) => [room.id, room.ranges]));
    expect(byRoom).toEqual({ r1: ["oct-28"], r2: ["nov-02"] });
    // Both writes were compare-and-set, and each bumped the token it checked.
    expect(writes).toHaveLength(2);
    expect(writes.every((write) => write.viaCas)).toBe(true);
    expect(row.occupancy_revision).toBe(9);
  });

  it("four rooms at once (SYNC_ALL_CONCURRENCY) all land", async () => {
    const row = house(0);
    row.property_data.listingSubmission.rooms = ["r1", "r2", "r3", "r4"].map((id) => ({ id, ranges: [] }));
    const { db } = fakeDb(row);
    await Promise.all(["r1", "r2", "r3", "r4"].map((id) => updateListingSubmission(db, "prop-1", addRange(id, `${id}-range`))));
    expect(row.property_data.listingSubmission.rooms.map((room) => room.ranges)).toEqual([["r1-range"], ["r2-range"], ["r3-range"], ["r4-range"]]);
  });

  it("gives up with a conflict error rather than overwrite when the row keeps moving", async () => {
    const row = house(1);
    const { db } = fakeDb(row, { alwaysMiss: true });
    await expect(updateListingSubmission(db, "prop-1", addRange("r1", "x"))).rejects.toBeInstanceOf(ListingSubmissionConflictError);
    expect(row.property_data.listingSubmission.rooms[0]!.ranges).toEqual([]);
  });

  it("a database without the revision token falls back to the plain write", async () => {
    const row = house(null);
    const { db, writes } = fakeDb(row);
    await updateListingSubmission(db, "prop-1", addRange("r1", "plain"));
    expect(row.property_data.listingSubmission.rooms[0]!.ranges).toEqual(["plain"]);
    expect(writes[0]!.viaCas).toBe(false);
  });

  it("returns null and writes nothing for a house with no listing submission", async () => {
    const row = house(3);
    (row.property_data as unknown as { listingSubmission?: unknown }).listingSubmission = undefined;
    const { db, writes } = fakeDb(row);
    expect(await updateListingSubmission(db, "prop-1", (s) => s)).toBeNull();
    expect(writes).toHaveLength(0);
  });
});
