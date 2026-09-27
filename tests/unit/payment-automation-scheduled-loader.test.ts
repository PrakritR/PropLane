import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  enrichHouseholdChargesFromPropertyRecords: async (_db: unknown, charges: unknown[]) => charges,
}));
vi.mock("@/lib/household-charges", () => ({
  filterChargesEligibleForPaymentReminders: (charges: unknown[]) => charges,
}));
vi.mock("@/lib/scheduled-payment-messages", () => ({
  projectScheduledPaymentMessages: vi.fn(() => []),
}));

import { loadListingByPropertyId, loadManagerScheduledMessages } from "@/lib/payment-automation-server";
import { projectScheduledPaymentMessages } from "@/lib/scheduled-payment-messages";

type Row = Record<string, unknown>;

function fakeDb(properties: Row[], charges: Row[] = [], propertyError?: Error) {
  const propertyQueries: Array<string[] | undefined> = [];
  const db = {
    from(table: string) {
      let ids: string[] | undefined;
      let selected = "";
      const query = {
        select(columns: string) { selected = columns; return query; },
        eq() { return query; },
        limit() { return query; },
        in(_column: string, values: string[]) { ids = values; return query; },
        async maybeSingle() { return { data: null, error: null }; },
        then(resolve: (value: { data: Row[]; error: Error | null }) => unknown) {
          if (table === "manager_property_records" && selected === "id, property_data") {
            propertyQueries.push(ids);
            return Promise.resolve(resolve({
              data: properties.filter((row) => ids === undefined || ids.includes(String(row.id))),
              error: propertyError ?? null,
            }));
          }
          return Promise.resolve(resolve({
            data: table === "portal_household_charge_records" ? charges : [],
            error: null,
          }));
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { db, propertyQueries };
}

const validProperty = {
  id: "relevant",
  property_data: { listingSubmission: createDefaultListingSubmission() },
};
const malformedProperty = { id: "unrelated", property_data: { listingSubmission: { v: 1 } } };

describe("scheduled payment listing loader", () => {
  it("normalizes only listings named by the manager's eligible charges and preserves projection", async () => {
    const { db, propertyQueries } = fakeDb([validProperty, malformedProperty], [
      { row_data: { id: "charge-1", propertyId: "relevant" } },
    ]);
    const result = await loadManagerScheduledMessages(db, "manager-1", { includeHidden: true });
    expect(propertyQueries).toEqual([["relevant"]]);
    expect(result.messages).toEqual([]);
    expect(vi.mocked(projectScheduledPaymentMessages).mock.lastCall?.[0]).toMatchObject({
      managerUserId: "manager-1",
      includeHidden: true,
      listingByPropertyId: new Map([["relevant", expect.objectContaining({ v: 1 })]]),
    });
  });

  it("deduplicates IDs and bounds each query for the maximum charge set", async () => {
    const { db, propertyQueries } = fakeDb([]);
    const ids = Array.from({ length: 1000 }, (_, index) => `property-${index}`);
    await loadListingByPropertyId(db, [...ids, ids[0]!, ids[999]!]);
    expect(propertyQueries).toHaveLength(10);
    expect(propertyQueries.flat()).toEqual(ids);
    expect(propertyQueries.every((batch) => (batch?.length ?? 0) <= 100)).toBe(true);
  });

  it("queries no properties for an explicit empty set and retains unscoped callers", async () => {
    const { db, propertyQueries } = fakeDb([validProperty]);
    await loadManagerScheduledMessages(db, "manager-1");
    expect(propertyQueries).toEqual([]);
    expect(await loadListingByPropertyId(db, [])).toEqual(new Map());
    expect(propertyQueries).toEqual([]);
    expect((await loadListingByPropertyId(db)).has("relevant")).toBe(true);
    expect(propertyQueries).toEqual([undefined]);
  });

  it("surfaces query errors and malformed relevant listings", async () => {
    const failure = new Error("property read failed");
    const charge = { row_data: { id: "charge-1", propertyId: "relevant" } };
    await expect(loadManagerScheduledMessages(fakeDb([], [charge], failure).db, "manager-1")).rejects.toBe(failure);
    expect(await loadListingByPropertyId(fakeDb([], [], failure).db)).toEqual(new Map());
    await expect(loadListingByPropertyId(fakeDb([malformedProperty]).db, ["unrelated"])).rejects.toThrow();
  });
});
