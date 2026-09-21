import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  isUpcomingHouseholdCharge,
  RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS,
  residentCanSeeCharge,
  type HouseholdChargeWithVisibility,
} from "@/lib/household-charge-visibility";

/**
 * PLAN-0920-2357 stream B: the manager Payments "Upcoming" group
 * (`isUpcomingHouseholdCharge`) and the resident 7-day early-visibility window
 * (`residentCanSeeCharge`). Fixed `now` throughout so month/day-boundary math
 * never depends on the day this suite happens to run.
 */
const NOW = new Date(2026, 8, 21); // Sep 21, 2026 (local)

/**
 * A `dueDateLabel` this many local calendar days from `NOW`, formatted so
 * `parseDueDateLabelToDate` (household-charges.ts) parses it back to that
 * exact local day regardless of which timezone this suite runs in. A bare
 * "YYYY-MM-DD" label parses as UTC midnight, which can land on the PREVIOUS
 * local day in a timezone west of UTC — `.toString()` embeds this runner's
 * own current offset, so there is no such ambiguity to round-trip through.
 */
function dueLabelDaysFromNow(days: number): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days, 12, 0, 0, 0).toString();
}

function charge(over: Partial<HouseholdCharge> & Pick<HouseholdCharge, "id">): HouseholdCharge {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    residentEmail: "resident@example.com",
    residentName: "Resident Example",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Prop One",
    managerUserId: "mgr-1",
    kind: "rent",
    title: "Rent",
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    ...over,
  } as HouseholdCharge;
}

describe("isUpcomingHouseholdCharge", () => {
  it("is true for a rentMonth later than the current month", () => {
    expect(isUpcomingHouseholdCharge(charge({ id: "a", rentMonth: "2026-10" }), NOW)).toBe(true);
  });

  it("is false for the current rentMonth", () => {
    expect(isUpcomingHouseholdCharge(charge({ id: "a", rentMonth: "2026-09" }), NOW)).toBe(false);
  });

  it("is false for a past rentMonth", () => {
    expect(isUpcomingHouseholdCharge(charge({ id: "a", rentMonth: "2026-08" }), NOW)).toBe(false);
  });

  it("falls back to the due date's month when there is no rentMonth", () => {
    expect(isUpcomingHouseholdCharge(charge({ id: "a", dueDateLabel: "2026-11-05" }), NOW)).toBe(true);
    expect(isUpcomingHouseholdCharge(charge({ id: "a", dueDateLabel: "2026-09-30" }), NOW)).toBe(false);
  });

  it("is never upcoming with no resolvable due date at all", () => {
    expect(isUpcomingHouseholdCharge(charge({ id: "a" }), NOW)).toBe(false);
  });

  it("is false once the charge is paid, cancelled, or refunded — no matter the month", () => {
    for (const status of ["paid", "cancelled", "refunded"] as const) {
      expect(
        isUpcomingHouseholdCharge(charge({ id: status, status, rentMonth: "2099-01" }), NOW),
      ).toBe(false);
    }
  });

  it("stays upcoming while processing or partially paid, for a future month", () => {
    expect(
      isUpcomingHouseholdCharge(charge({ id: "a", status: "processing", rentMonth: "2026-10" }), NOW),
    ).toBe(true);
    expect(
      isUpcomingHouseholdCharge(charge({ id: "b", status: "partially_paid", rentMonth: "2026-10" }), NOW),
    ).toBe(true);
  });
});

describe("residentCanSeeCharge", () => {
  it("is always visible when overdue", () => {
    const c = charge({ id: "a", dueDateLabel: "2026-09-01" });
    expect(residentCanSeeCharge(c, NOW)).toBe(true);
  });

  it("is always visible while processing, partially paid, or paid — regardless of due date", () => {
    for (const status of ["processing", "partially_paid", "paid"] as const) {
      const c = charge({ id: status, status, dueDateLabel: "2099-01-01", balanceLabel: status === "paid" ? "$0.00" : "$100.00" });
      expect(residentCanSeeCharge(c, NOW)).toBe(true);
    }
  });

  it("is always visible with no parseable due date", () => {
    expect(residentCanSeeCharge(charge({ id: "a" }), NOW)).toBe(true);
  });

  it("is visible when a manager has explicitly surfaced it early, however far out it is due", () => {
    const c: HouseholdChargeWithVisibility = {
      ...charge({ id: "a", dueDateLabel: "2099-01-01" }),
      residentVisibleAt: "2026-09-20T00:00:00.000Z",
    };
    expect(residentCanSeeCharge(c, NOW)).toBe(true);
  });

  it(`is visible exactly ${RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS} days out (inclusive)`, () => {
    const c = charge({ id: "a", dueDateLabel: dueLabelDaysFromNow(RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS) });
    expect(residentCanSeeCharge(c, NOW)).toBe(true);
  });

  it(`is hidden ${RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS + 1} days out`, () => {
    const c = charge({ id: "a", dueDateLabel: dueLabelDaysFromNow(RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS + 1) });
    expect(residentCanSeeCharge(c, NOW)).toBe(false);
  });

  it("is hidden well beyond the window, for an ordinary pending charge", () => {
    const c = charge({ id: "a", dueDateLabel: dueLabelDaysFromNow(24) }); // Sep 21 -> mid-October
    expect(residentCanSeeCharge(c, NOW)).toBe(false);
  });

  it("respects a custom windowDays override", () => {
    const c = charge({ id: "a", dueDateLabel: dueLabelDaysFromNow(14) });
    expect(residentCanSeeCharge(c, NOW, 3)).toBe(false);
    expect(residentCanSeeCharge(c, NOW, 14)).toBe(true);
  });
});
