/**
 * `lookupFailed` distinguishes a listing that collects offline from a failed
 * property read. A manager payout account is not required for platform checkout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { enrichHouseholdChargesFromPropertyRecordsResult } from "@/lib/household-charge-payment-eligibility.server";
import type { HouseholdCharge } from "@/lib/household-charges";

const fail: Record<string, boolean> = {};

function fakeDb() {
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) =>
        Promise.resolve(
          fail[table]
            ? { data: null, error: { message: `${table} unavailable` } }
            : { data: [], error: null },
        ).then(resolve),
    };
    return q;
  };
  return { db: { from } as never, reads };
}

const charge = {
  id: "hc_1",
  createdAt: "2026-10-03T00:00:00.000Z",
  residentEmail: "r@x.co",
  residentName: "Rae",
  residentUserId: null,
  propertyId: "prop-1",
  propertyLabel: "Cascade Lofts",
  managerUserId: "mgr-1",
  kind: "lease_fee",
  title: "Lease fee",
  amountLabel: "$300.00",
  balanceLabel: "$300.00",
  status: "pending",
  blocksLeaseUntilPaid: false,
} as unknown as HouseholdCharge;

beforeEach(() => {
  for (const key of Object.keys(fail)) delete fail[key];
});

describe("enrichHouseholdChargesFromPropertyRecordsResult", () => {
  it("reports no failure when every read succeeds", async () => {
    const result = await enrichHouseholdChargesFromPropertyRecordsResult(fakeDb().db, [charge]);
    expect(result.lookupFailed).toBe(false);
    expect(result.charges).toHaveLength(1);
  });

  it("reports a failed property read", async () => {
    fail.manager_property_records = true;
    expect((await enrichHouseholdChargesFromPropertyRecordsResult(fakeDb().db, [charge])).lookupFailed).toBe(true);
  });

  it("does not read payout accounts or block an otherwise payable charge", async () => {
    fail.profiles = true;
    const { db, reads } = fakeDb();
    const result = await enrichHouseholdChargesFromPropertyRecordsResult(db, [charge]);
    expect(result.lookupFailed).toBe(false);
    expect(reads).not.toContain("profiles");
    expect(result.charges[0]!.managerStripeConnectReadySnapshot).toBeUndefined();
  });

  it("says nothing failed for an empty list", async () => {
    fail.profiles = true;
    expect((await enrichHouseholdChargesFromPropertyRecordsResult(fakeDb().db, [])).lookupFailed).toBe(false);
  });
});
