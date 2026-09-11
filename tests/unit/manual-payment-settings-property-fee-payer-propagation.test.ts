import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { LISTING_PAYMENT_WAIVER_CODE } from "@/lib/payment-policy";
import {
  applyPropertyServiceFeePayersToListings,
  loadPropertyServiceFeePayers,
} from "@/lib/manager-manual-payment-settings.server";

const MANAGER_ID = "mgr-bulk-fee-payer";

type Row = { id: string; manager_user_id: string; row_data: Record<string, unknown>; property_data: Record<string, unknown> };

function makeDb(rows: Row[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "manager_property_records") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_col: string, managerId: string) => ({
            in: async (_idCol: string, ids: string[]) => ({
              data: rows.filter((row) => row.manager_user_id === managerId && ids.includes(row.id)),
              error: null,
            }),
          }),
        }),
        update: (patch: Partial<Row>) => ({
          eq: async (_col: string, id: string) => {
            const row = rows.find((candidate) => candidate.id === id);
            if (row) Object.assign(row, patch);
            return { error: null };
          },
        }),
      };
    },
  } as unknown as SupabaseClient;
}

function listingRow(id: string, overrides: Record<string, unknown> = {}): Row {
  const submission = { ...createDefaultListingSubmission(), serviceFeePayer: "resident", ...overrides };
  return {
    id,
    manager_user_id: MANAGER_ID,
    row_data: { submission },
    property_data: { listingSubmission: submission },
  };
}

function storedPayer(row: Row) {
  const propertySubmission = (row.property_data.listingSubmission ?? {}) as Record<string, unknown>;
  const rowSubmission = (row.row_data.submission ?? {}) as Record<string, unknown>;
  return {
    propertyData: propertySubmission.serviceFeePayer,
    rowData: rowSubmission.serviceFeePayer,
    waiverCode: propertySubmission.serviceFeeWaiverCode,
  };
}

describe("applyPropertyServiceFeePayersToListings · staff-only PropLane coverage", () => {
  it("downgrades a bulk 'proplane' write to resident when the account has no staff override", async () => {
    const rows = [listingRow("prop-1"), listingRow("prop-2")];
    const db = makeDb(rows);

    const result = await applyPropertyServiceFeePayersToListings(
      db,
      MANAGER_ID,
      [
        { propertyId: "prop-1", serviceFeePayer: "proplane" },
        { propertyId: "prop-2", serviceFeePayer: "manager" },
      ],
      false,
    );

    expect(result.listingsUpdated).toBe(2);
    expect(storedPayer(rows[0])).toMatchObject({ propertyData: "resident", rowData: "resident" });
    expect(storedPayer(rows[0]).waiverCode).toBeUndefined();
    expect(storedPayer(rows[1])).toMatchObject({ propertyData: "manager", rowData: "manager" });
    await expect(loadPropertyServiceFeePayers(db, MANAGER_ID, ["prop-1", "prop-2"])).resolves.toEqual({
      "prop-1": "resident",
      "prop-2": "manager",
    });
  });

  it("defaults to unapproved when the caller omits the grant", async () => {
    const rows = [listingRow("prop-1")];
    const db = makeDb(rows);

    await applyPropertyServiceFeePayersToListings(db, MANAGER_ID, [
      { propertyId: "prop-1", serviceFeePayer: "proplane" },
    ]);

    expect(storedPayer(rows[0])).toMatchObject({ propertyData: "resident", rowData: "resident" });
  });

  it("keeps a bulk 'proplane' write when staff granted the override", async () => {
    const rows = [listingRow("prop-1")];
    const db = makeDb(rows);

    const result = await applyPropertyServiceFeePayersToListings(
      db,
      MANAGER_ID,
      [{ propertyId: "prop-1", serviceFeePayer: "proplane" }],
      true,
    );

    expect(result.listingsUpdated).toBe(1);
    expect(storedPayer(rows[0])).toMatchObject({ propertyData: "proplane", rowData: "proplane" });
    await expect(loadPropertyServiceFeePayers(db, MANAGER_ID, ["prop-1"])).resolves.toEqual({
      "prop-1": "proplane",
    });
  });

  it("clears a listing back to following the account setting and never touches other managers' rows", async () => {
    const rows = [
      listingRow("prop-1", { serviceFeePayer: "proplane", serviceFeeWaiverCode: LISTING_PAYMENT_WAIVER_CODE }),
      { ...listingRow("prop-other"), manager_user_id: "someone-else" },
    ];
    const db = makeDb(rows);

    const result = await applyPropertyServiceFeePayersToListings(
      db,
      MANAGER_ID,
      [
        { propertyId: "prop-1", serviceFeePayer: null },
        { propertyId: "prop-other", serviceFeePayer: "proplane" },
      ],
      true,
    );

    expect(result.listingsUpdated).toBe(1);
    expect(storedPayer(rows[0])).toEqual({ propertyData: null, rowData: null, waiverCode: undefined });
    expect(storedPayer(rows[1])).toMatchObject({ propertyData: "resident", rowData: "resident" });
  });
});
