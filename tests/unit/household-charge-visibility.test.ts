import { describe, expect, it } from "vitest";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  isAlwaysResidentVisibleCharge,
  isUpcomingHouseholdCharge,
  RESIDENT_CHARGE_VISIBILITY_WINDOW_DAYS,
  residentCanSeeCharge,
  residentVisibleCharges,
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

  it("never hides money the resident must pay to move in, however far out it is due", () => {
    const farOut = dueLabelDaysFromNow(60);
    for (const kind of ["security_deposit", "first_month_rent", "prorated_rent", "move_in_fee", "other_cost", "payment_at_signing"] as const) {
      const c = charge({ id: kind, kind, dueDateLabel: farOut });
      expect(isAlwaysResidentVisibleCharge(c), kind).toBe(true);
      expect(residentCanSeeCharge(c, NOW), kind).toBe(true);
    }
  });

  it("never hides a charge that blocks lease signing until paid", () => {
    const c = charge({ id: "a", kind: "rent", blocksLeaseUntilPaid: true, dueDateLabel: dueLabelDaysFromNow(60) });
    expect(residentCanSeeCharge(c, NOW)).toBe(true);
  });

  it("still applies the window to a recurring rent or utilities month", () => {
    const rent = charge({ id: "r", kind: "rent", recurringRentProfileId: "rrp-1", rentMonth: "2026-11", dueDateLabel: dueLabelDaysFromNow(40) });
    const utilities = charge({ id: "u", kind: "utilities", recurringRentProfileId: "rrp-1", rentMonth: "2026-11", dueDateLabel: dueLabelDaysFromNow(40) });
    const monthlyFee = charge({ id: "f", kind: "other_cost", customFeeId: "fee-parking", recurringRentProfileId: "rrp-1", rentMonth: "2026-11", dueDateLabel: dueLabelDaysFromNow(40) });
    expect(isAlwaysResidentVisibleCharge(rent)).toBe(false);
    expect(residentCanSeeCharge(rent, NOW)).toBe(false);
    expect(residentCanSeeCharge(utilities, NOW)).toBe(false);
    expect(residentCanSeeCharge(monthlyFee, NOW)).toBe(false);
  });
});

describe("residentVisibleCharges — a lease starting 30 days out", () => {
  // Every move-in line the signature bills carries `dueDateLabel = "Before <lease start>"`,
  // which parses to the lease-start date — 30 days out, well past the 7-day window.
  const leaseStart = dueLabelDaysFromNow(30);
  const deposit = charge({ id: "deposit", kind: "security_deposit", title: "Security deposit", dueDateLabel: leaseStart });
  const firstMonth = charge({ id: "first", kind: "first_month_rent", title: "First month's rent", dueDateLabel: leaseStart });
  const nextMonthRent = charge({
    id: "next-rent",
    kind: "rent",
    recurringRentProfileId: "rrp-1",
    rentMonth: "2026-11",
    title: "Rent — November",
    dueDateLabel: dueLabelDaysFromNow(60),
  });

  it("keeps the deposit and first month visible while next month's recurring rent stays hidden", () => {
    const visible = residentVisibleCharges([deposit, firstMonth, nextMonthRent], NOW).map((c) => c.id);
    expect(visible).toEqual(["deposit", "first"]);
  });

  it("shows the recurring month once it is inside the window", () => {
    // A rent row's due date derives from `rentMonth` + `dueDay` (see
    // `householdChargeDueDate`): October 1 is 10 days past Sep 21, so it is
    // hidden from NOW but visible one week before the 1st.
    const october = { ...nextMonthRent, rentMonth: "2026-10", dueDay: 1 };
    expect(residentVisibleCharges([deposit, firstMonth, october], NOW).map((c) => c.id)).toEqual(["deposit", "first"]);
    const oneWeekBefore = new Date(2026, 8, 24);
    expect(residentVisibleCharges([deposit, firstMonth, october], oneWeekBefore).map((c) => c.id)).toEqual([
      "deposit",
      "first",
      "next-rent",
    ]);
  });

  it("tolerates a raw row without a resident email", () => {
    const raw = { ...deposit, residentEmail: undefined } as unknown as HouseholdCharge;
    expect(() => residentVisibleCharges([raw], NOW)).not.toThrow();
  });
});
