/**
 * `lookupFailed` distinguishes a listing that collects offline from a failed
 * property read. A manager payout account is not required for platform checkout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { enrichHouseholdChargesFromPropertyRecordsResult, resolvePropertylessManagerPaymentPolicy } from "@/lib/household-charge-payment-eligibility.server";
import { enrichHouseholdChargePaymentFlags, householdChargeProplanePayability } from "@/lib/household-charge-payment-eligibility";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
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
  it("uses the current listing over a stale creation snapshot in both directions", () => {
    const listing = createDefaultListingSubmission();
    const turnedOn = enrichHouseholdChargePaymentFlags({ ...charge, axisPaymentsEnabledSnapshot: false }, listing);
    expect(householdChargeProplanePayability(turnedOn)).toBe("payable");
    expect(turnedOn.acceptedPaymentMethodsSnapshot).toEqual(["ach", "card"]);

    const turnedOff = enrichHouseholdChargePaymentFlags({ ...charge, axisPaymentsEnabledSnapshot: true }, {
      ...listing, axisPaymentsEnabled: false, acceptedPaymentMethods: ["ach"],
    });
    expect(householdChargeProplanePayability(turnedOff)).toBe("offline");
    expect(turnedOff.acceptedPaymentMethodsSnapshot).toEqual(["ach"]);
  });

  it("fails closed when the current listing cannot be resolved, even with a stored on snapshot", () => {
    const unresolved = enrichHouseholdChargePaymentFlags({ ...charge, axisPaymentsEnabledSnapshot: true }, null);
    expect(unresolved.axisPaymentsEnabledSnapshot).toBeNull();
    expect(unresolved.acceptedPaymentMethodsSnapshot).toBeUndefined();
    expect(householdChargeProplanePayability(unresolved)).toBe("unknown");
  });

  it("reads a propertyless one-off from the exact manager account setting, not its old snapshot", async () => {
    const managerIds: string[] = [];
    const db = { from(table: string) {
      if (table !== "manager_automation_settings") throw new Error(`Unexpected ${table}`);
      const q = { select: () => q, eq: (_key: string, managerId: string) => { managerIds.push(managerId); return q; },
        maybeSingle: async () => ({ data: { manual_payments: { axisPaymentsEnabled: false } }, error: null }) };
      return q;
    } } as never;
    const propertyless = { ...charge, propertyId: "", axisPaymentsEnabledSnapshot: true };
    const result = await enrichHouseholdChargesFromPropertyRecordsResult(db, [propertyless]);
    expect(managerIds).toEqual(["mgr-1"]);
    expect(householdChargeProplanePayability(result.charges[0]!)).toBe("offline");
    expect(result.charges[0]!.acceptedPaymentMethodsSnapshot).toEqual(["ach", "card"]);
  });

  it("treats a missing propertyless account policy as unknown", async () => {
    const db = { from: () => {
      const q = { select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: { manual_payments: {} }, error: null }) };
      return q;
    } } as never;
    expect(await resolvePropertylessManagerPaymentPolicy(db, "mgr-1")).toBeNull();
    const result = await enrichHouseholdChargesFromPropertyRecordsResult(db, [{ ...charge, propertyId: "", axisPaymentsEnabledSnapshot: true }]);
    expect(result.lookupFailed).toBe(true);
    expect(householdChargeProplanePayability(result.charges[0]!)).toBe("unknown");
  });

  it("uses the exact property's owner's listing even when a co-manager created the charge", async () => {
    const db = { from: (table: string) => {
      if (table !== "manager_property_records") throw new Error(`Unexpected ${table}`);
      const q = { select: () => q, in: () => q,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: "prop-1", manager_user_id: "owner-1",
          property_data: { listingSubmission: { ...createDefaultListingSubmission(), axisPaymentsEnabled: false } } }], error: null }).then(resolve) };
      return q;
    } } as never;
    const result = await enrichHouseholdChargesFromPropertyRecordsResult(db, [{ ...charge, axisPaymentsEnabledSnapshot: true }]);
    expect(result.lookupFailed).toBe(false);
    expect(householdChargeProplanePayability(result.charges[0]!)).toBe("offline");
  });

  it("does not accept a listing with no owner or borrow another same-label listing", async () => {
    const db = { from: (table: string) => {
      if (table !== "manager_property_records") throw new Error(`Unexpected ${table}`);
      const q = { select: () => q, in: () => q,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: "prop-1", manager_user_id: null,
          property_data: { listingSubmission: createDefaultListingSubmission() } }], error: null }).then(resolve) };
      return q;
    } } as never;
    const result = await enrichHouseholdChargesFromPropertyRecordsResult(db, [{ ...charge, axisPaymentsEnabledSnapshot: true }]);
    expect(householdChargeProplanePayability(result.charges[0]!)).toBe("unknown");
  });
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
