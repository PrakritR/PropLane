/**
 * `loadManagerDoorCount` — the server-side portfolio door total and its
 * per-listing breakdown (docs/agents/plan-entitlements.md). Billable listings
 * are exactly `LISTING_SLOT_PROPERTY_STATUSES` (`pending`, `live`, `review`),
 * the same set the property-listing cap counts
 * (`assertManagerPropertyListingQuota` / `manager-property-quota.server.ts`) —
 * a deleted, archived, draft, unlisted, rejected or request-change row must
 * never bill.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerDoorCount } from "@/lib/billing/door-count.server";

type FakeRow = {
  id: string;
  manager_user_id: string;
  status: string;
  row_data: unknown;
  property_data: unknown;
};

/**
 * Minimal stand-in for the one query `loadManagerDoorCount` issues:
 * `.from("manager_property_records").select(...).eq("manager_user_id", x).in("status", [...])`.
 * Filters exactly like PostgREST would, so this also proves which statuses the
 * real query asks for.
 */
function fakeDb(rows: FakeRow[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "manager_property_records") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            eq(col: string, val: string) {
              const owned = rows.filter((r) => (r as Record<string, unknown>)[col] === val);
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
    },
  } as unknown as SupabaseClient;
}

const pendingRow = (over: Partial<FakeRow> = {}): FakeRow => ({
  id: "prop-pending",
  manager_user_id: "manager-1",
  status: "pending",
  row_data: {
    buildingName: "123 Main St",
    submission: { listingPlaceCategoryId: "shared_home", rooms: [{ occupancyCapacity: 2 }, { occupancyCapacity: 2 }] },
  },
  property_data: null,
  ...over,
});

const liveRow = (over: Partial<FakeRow> = {}): FakeRow => ({
  id: "prop-live",
  manager_user_id: "manager-1",
  status: "live",
  row_data: null,
  property_data: {
    buildingName: "456 Oak Ave",
    listingSubmission: { listingPlaceCategoryId: "entire_home", rooms: [] },
  },
  ...over,
});

describe("loadManagerDoorCount", () => {
  it("totals only billable statuses (pending, live, review), excluding draft/unlisted/rejected/request_change", async () => {
    const db = fakeDb([
      pendingRow(), // 4 doors (rooms)
      liveRow(), // 1 door (whole-home)
      { ...liveRow(), id: "prop-review", status: "review", property_data: { buildingName: "789 Elm", listingSubmission: { rooms: [{ occupancyCapacity: 3 }] } } }, // 3 doors
      { ...pendingRow(), id: "prop-draft", status: "draft" },
      { ...liveRow(), id: "prop-unlisted", status: "unlisted" },
      { ...liveRow(), id: "prop-rejected", status: "rejected" },
      { ...pendingRow(), id: "prop-request-change", status: "request_change" },
      { ...pendingRow(), id: "other-manager", manager_user_id: "manager-2" },
    ]);

    const result = await loadManagerDoorCount(db, "manager-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.breakdown.map((b) => b.propertyId).sort()).toEqual(["prop-live", "prop-pending", "prop-review"]);
    expect(result.totalDoors).toBe(8); // 4 + 1 + 3
  });

  it("the portfolio total always equals the sum of the breakdown", async () => {
    const db = fakeDb([
      pendingRow({ id: "a", row_data: { buildingName: "A", submission: { rooms: [{ occupancyCapacity: 5 }] } } }),
      liveRow({ id: "b", property_data: { buildingName: "B", listingSubmission: { listingPlaceCategoryId: "entire_home" } } }),
      { ...pendingRow(), id: "c", status: "review", row_data: null, property_data: { buildingName: "C", listingSubmission: {} } },
    ]);

    const result = await loadManagerDoorCount(db, "manager-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.totalDoors).toBe(result.breakdown.reduce((sum, entry) => sum + entry.doors, 0));
    expect(result.breakdown.find((b) => b.propertyId === "a")).toMatchObject({ doors: 5, basis: "rooms" });
    expect(result.breakdown.find((b) => b.propertyId === "b")).toMatchObject({ doors: 1, basis: "whole-home" });
    // "c" has no rooms recorded and is not entire_home — 1 door, unrecorded.
    expect(result.breakdown.find((b) => b.propertyId === "c")).toMatchObject({ doors: 1, basis: "unrecorded" });
  });

  it("labels a breakdown line from the record's own buildingName", () => {
    return loadManagerDoorCount(fakeDb([pendingRow()]), "manager-1").then((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.breakdown[0]).toMatchObject({ label: "123 Main St" });
    });
  });

  it("surfaces a read error rather than reading it as zero doors", async () => {
    const db = {
      from() {
        return {
          select() {
            return {
              eq() {
                return { in: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;

    const result = await loadManagerDoorCount(db, "manager-1");
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});
