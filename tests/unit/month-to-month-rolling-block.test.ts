import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPEN_ENDED_BOOKING_HORIZON_DAYS,
  applicationHoldEntries,
  isMonthToMonthTerm,
  leaseBlockEnd,
  leaseBookingEntries,
  openEndedBookingHorizonKey,
  openEndedLeaseEnd,
  type ApplicationHoldRow,
  type LeaseBookingRow,
} from "@/lib/channel-calendar/property-bookings";

// Captain: a month-to-month lease blocks its room for 1 year, rolling from today; a move-out date ends it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

describe("month-to-month rolling block", () => {
  it("is one year, not two", () => {
    expect(OPEN_ENDED_BOOKING_HORIZON_DAYS).toBe(365);
    expect(openEndedBookingHorizonKey()).toBe("2027-11-16");
  });

  it("recognises the term in any casing or spelling", () => {
    for (const t of ["Month-to-Month", "month to month", "MONTH_TO_MONTH", "Month-2-Month"]) expect(isMonthToMonthTerm(t)).toBe(true);
    for (const t of ["12 months", "", undefined, "Short-term"]) expect(isMonthToMonthTerm(t)).toBe(false);
  });

  it("openEndedLeaseEnd: today+365, move-out wins, never before start", () => {
    expect(openEndedLeaseEnd("2026-09-01")).toBe("2027-11-16");
    expect(openEndedLeaseEnd("2026-09-01", "2027-01-31")).toBe("2027-01-31");
    expect(openEndedLeaseEnd("2030-01-01")).toBe("2030-01-01");
  });

  it("leaseBlockEnd: month-to-month ignores a stored end date; fixed term keeps it; move-out wins", () => {
    expect(leaseBlockEnd({ start: "2026-09-01", leaseEnd: "2026-12-01", leaseTerm: "Month-to-Month" })).toEqual({ end: "2027-11-16", openEnded: true });
    expect(leaseBlockEnd({ start: "2026-09-01", leaseEnd: "" })).toEqual({ end: "2027-11-16", openEnded: true });
    expect(leaseBlockEnd({ start: "2026-09-01", leaseEnd: "2027-08-31", leaseTerm: "12 months" })).toEqual({ end: "2027-08-31", openEnded: false });
    expect(leaseBlockEnd({ start: "2026-09-01", leaseEnd: "2027-08-31", moveOut: "2027-02-14", leaseTerm: "Month-to-Month" })).toEqual({ end: "2027-02-14", openEnded: false });
  });

  it("the horizon rolls: the same lease blocks one day further tomorrow", () => {
    const row: LeaseBookingRow = {
      propertyId: "p1", roomChoice: "p1::r1", residentName: "Ana", status: "Fully Signed", fullySignedAt: "2026-08-01",
      managerSignature: { name: "M", signedAtIso: "2026-08-01" }, residentSignature: { name: "A", signedAtIso: "2026-08-01" },
      application: { leaseStart: "2026-09-01", leaseTerm: "Month-to-Month" },
    };
    const run = () => leaseBookingEntries([row], { propertyId: "p1", propertyLabel: "P", roomLabelForId: () => "R", openEndedHorizonKey: openEndedBookingHorizonKey() });
    expect(run()[0]?.end).toBe("2027-11-16");
    vi.setSystemTime(new Date(2026, 10, 17, 12, 0, 0));
    expect(run()[0]?.end).toBe("2027-11-17");
  });

  it("an approved application with a month-to-month term holds to today+365 even with a stale end; move-out ends it", () => {
    const base: ApplicationHoldRow = {
      id: "A1", bucket: "approved", propertyId: "p1", assignedPropertyId: "p1", assignedRoomChoice: "p1::r1", name: "Ana",
      application: { leaseStart: "2026-09-01", leaseEnd: "2026-12-01" },
      manualResidentDetails: { moveInDate: "2026-09-01", leaseTerm: "Month-to-Month" },
    };
    const opts = { properties: [{ id: "p1", label: "P" }], roomLabelForId: () => "R", isLeased: () => false, openEndedHorizonKey: openEndedBookingHorizonKey() };
    expect(applicationHoldEntries([base], opts)[0]).toMatchObject({ start: "2026-09-01", end: "2027-11-16", openEnded: true });
    const moving = { ...base, manualResidentDetails: { ...base.manualResidentDetails, moveOutDate: "2027-03-31" } };
    expect(applicationHoldEntries([moving], opts)[0]).toMatchObject({ end: "2027-03-31" });
    expect(applicationHoldEntries([moving], opts)[0]?.openEnded).toBeUndefined();
  });
});
