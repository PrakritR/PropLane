import { describe, expect, it } from "vitest";
import { residentCanSeeCharge, residentVisibleCharges, type HouseholdChargeWithVisibility } from "@/lib/household-charge-visibility";

/**
 * PLAN-0920-2357 stream B: the resident Payments screen (and the assistant's
 * matching `list_my_charges` tool) hides a not-yet-due charge until it is
 * within the visibility window, so a resident is never shown next month's
 * rent nine days early. Scenario-level companion to the branch coverage in
 * `household-charge-visibility.test.ts`.
 */
function chargeDueOct1(over: Partial<HouseholdChargeWithVisibility> = {}): HouseholdChargeWithVisibility {
  return {
    id: "hc_rent_oct",
    createdAt: "2026-01-01T00:00:00.000Z",
    residentEmail: "resident@example.com",
    residentName: "Resident Example",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Prop One",
    managerUserId: "mgr-1",
    kind: "rent",
    title: "Rent — October 2026",
    amountLabel: "$1,800.00",
    balanceLabel: "$1,800.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    rentMonth: "2026-10",
    dueDateLabel: "Oct 1, 2026",
    ...over,
  } as HouseholdChargeWithVisibility;
}

describe("resident Payments visibility window — the October 1 rent charge", () => {
  it("is hidden on September 21, ten days before it is due", () => {
    const now = new Date(2026, 8, 21);
    expect(residentCanSeeCharge(chargeDueOct1(), now)).toBe(false);
  });

  it("becomes visible on September 24, once it is within the 7-day window", () => {
    const now = new Date(2026, 8, 24);
    expect(residentCanSeeCharge(chargeDueOct1(), now)).toBe(true);
  });

  it("is visible on September 21 when the manager has already surfaced it (residentVisibleAt)", () => {
    const now = new Date(2026, 8, 21);
    const charge = chargeDueOct1({ residentVisibleAt: "2026-09-20T18:00:00.000Z" });
    expect(residentCanSeeCharge(charge, now)).toBe(true);
  });

  it("never hides the move-in schedule for a lease starting 30 days out", () => {
    const now = new Date(2026, 8, 21);
    const leaseStart = "Before Oct 21, 2026";
    const deposit = chargeDueOct1({ id: "hc_deposit", kind: "security_deposit", rentMonth: undefined, dueDateLabel: leaseStart });
    const firstMonth = chargeDueOct1({ id: "hc_first", kind: "first_month_rent", rentMonth: undefined, dueDateLabel: leaseStart });
    const november = chargeDueOct1({ id: "hc_rent_nov", recurringRentProfileId: "rrp-1", rentMonth: "2026-11", dueDateLabel: "Nov 1, 2026" });
    expect(residentVisibleCharges([deposit, firstMonth, november], now).map((c) => c.id)).toEqual(["hc_deposit", "hc_first"]);
  });

  it("is visible any time once it is overdue, even far outside the normal window logic", () => {
    // Overdue is checked first and short-circuits everything else, so once
    // October 1 has passed unpaid the charge is unconditionally visible.
    const now = new Date(2026, 9, 2); // Oct 2, one day past due
    expect(residentCanSeeCharge(chargeDueOct1(), now)).toBe(true);
  });
});
