/**
 * `takeManagerDoorCountSnapshot` — per-account, per-billing-period door
 * snapshot (`supabase/migrations/20260922010000_door_count_snapshot.sql`).
 * Billing must read the snapshot, never a live count, so this pins down that
 * taking/refreshing a snapshot for the same (account, period) is idempotent:
 * one row, not a duplicate, even as the underlying listings change.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { takeManagerDoorCountSnapshot } from "@/lib/billing/door-count-snapshot.server";

type PropertyRow = {
  id: string;
  manager_user_id: string;
  status: string;
  row_data: unknown;
  property_data: unknown;
};

type SnapshotStoreRow = {
  manager_user_id: string;
  period_start: string;
  total_doors: number;
  breakdown: unknown;
  created_at: string;
};

/**
 * Stands in for both tables `takeManagerDoorCountSnapshot` touches:
 * `manager_property_records` (read, via `loadManagerDoorCount`) and
 * `manager_door_count_snapshots` (upsert on (manager_user_id, period_start),
 * exactly like the migration's unique index).
 */
function fakeDb(propertyRows: () => PropertyRow[]) {
  const store = new Map<string, SnapshotStoreRow>();
  let now = 0;

  const db = {
    from(table: string) {
      if (table === "manager_property_records") {
        return {
          select() {
            return {
              eq(col: string, val: string) {
                const owned = propertyRows().filter((r) => (r as Record<string, unknown>)[col] === val);
                return {
                  in(col2: string, vals: string[]) {
                    const data = owned.filter((r) => vals.includes((r as Record<string, unknown>)[col2] as string));
                    return Promise.resolve({ data, error: null });
                  },
                };
              },
            };
          },
        };
      }
      if (table === "manager_door_count_snapshots") {
        return {
          upsert(payload: Record<string, unknown>) {
            return {
              select() {
                return {
                  async single() {
                    const key = `${payload.manager_user_id}:${payload.period_start}`;
                    const existing = store.get(key);
                    now += 1;
                    const row: SnapshotStoreRow = {
                      manager_user_id: payload.manager_user_id as string,
                      period_start: payload.period_start as string,
                      total_doors: payload.total_doors as number,
                      breakdown: payload.breakdown,
                      // Preserve the ORIGINAL created_at across a refresh, same
                      // as a real upsert that never lists created_at as a
                      // column to update.
                      created_at: existing?.created_at ?? `2026-09-01T00:00:0${now}.000Z`,
                    };
                    store.set(key, row);
                    return { data: row, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { db, store };
}

const oneListing = (doors: number): PropertyRow[] => [
  {
    id: "prop-1",
    manager_user_id: "manager-1",
    status: "pending",
    row_data: {
      buildingName: "123 Main St",
      submission: { listingPlaceCategoryId: "shared_home", rooms: [{ occupancyCapacity: doors }] },
    },
    property_data: null,
  },
];

describe("takeManagerDoorCountSnapshot", () => {
  it("is idempotent for the same (account, period): repeated calls upsert one row, not duplicates", async () => {
    const { db, store } = fakeDb(() => oneListing(3));

    const first = await takeManagerDoorCountSnapshot(db, "manager-1", "2026-09-01");
    const second = await takeManagerDoorCountSnapshot(db, "manager-1", "2026-09-01");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(store.size).toBe(1);
    expect(second.snapshot.totalDoors).toBe(first.snapshot.totalDoors);
    expect(second.snapshot.createdAt).toBe(first.snapshot.createdAt);
  });

  it("refreshes the stored total when listings change, still as exactly one row for the period", async () => {
    let rows = oneListing(2);
    const { db, store } = fakeDb(() => rows);

    const first = await takeManagerDoorCountSnapshot(db, "manager-1", "2026-09-01");
    expect(first.ok && first.snapshot.totalDoors).toBe(2);

    rows = oneListing(7);
    const second = await takeManagerDoorCountSnapshot(db, "manager-1", "2026-09-01");
    expect(second.ok && second.snapshot.totalDoors).toBe(7);

    expect(store.size).toBe(1);
  });

  it("keeps separate accounts and separate periods as separate rows", async () => {
    const { db, store } = fakeDb(() => oneListing(1));

    await takeManagerDoorCountSnapshot(db, "manager-1", "2026-09-01");
    await takeManagerDoorCountSnapshot(db, "manager-2", "2026-09-01");
    await takeManagerDoorCountSnapshot(db, "manager-1", "2026-10-01");

    expect(store.size).toBe(3);
  });

  it("refuses a malformed period rather than silently taking a wrong-shaped snapshot", async () => {
    const { db } = fakeDb(() => oneListing(1));
    const result = await takeManagerDoorCountSnapshot(db, "manager-1", "not-a-date");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("periodStart") });
  });

  it("refuses an empty manager id", async () => {
    const { db } = fakeDb(() => oneListing(1));
    const result = await takeManagerDoorCountSnapshot(db, "  ", "2026-09-01");
    expect(result.ok).toBe(false);
  });
});
