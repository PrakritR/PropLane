/**
 * `lookupFailed` is what lets a gate tell "this property collects offline" from
 * "nothing could be read". Every read the enrichment makes has to feed it -
 * the payout-account read included, because a manager whose account is actually
 * unusable would otherwise read as payable and hold the resident at 402 behind
 * a checkout that cannot succeed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    throw new Error("no stripe in tests");
  },
}));
vi.mock("@/lib/stripe-connect", () => ({
  validateManagerConnectForDestinationCharge: async () => ({ ok: true }),
}));

import { enrichHouseholdChargesFromPropertyRecordsResult } from "@/lib/household-charge-payment-eligibility.server";
import type { HouseholdCharge } from "@/lib/household-charges";

const fail: Record<string, boolean> = {};

function fakeDb() {
  const from = (table: string) => {
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
  return { from } as never;
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
    const result = await enrichHouseholdChargesFromPropertyRecordsResult(fakeDb(), [charge]);
    expect(result.lookupFailed).toBe(false);
    expect(result.charges).toHaveLength(1);
  });

  it("reports a failed property read", async () => {
    fail.manager_property_records = true;
    expect((await enrichHouseholdChargesFromPropertyRecordsResult(fakeDb(), [charge])).lookupFailed).toBe(true);
  });

  it("reports a failed payout-account read too", async () => {
    fail.profiles = true;
    const result = await enrichHouseholdChargesFromPropertyRecordsResult(fakeDb(), [charge]);
    expect(result.lookupFailed).toBe(true);
    // Undefined, not false: nothing was learned about the account either way.
    expect(result.charges[0]!.managerStripeConnectReadySnapshot).toBeUndefined();
  });

  it("says nothing failed for an empty list", async () => {
    fail.profiles = true;
    expect((await enrichHouseholdChargesFromPropertyRecordsResult(fakeDb(), [])).lookupFailed).toBe(false);
  });
});
