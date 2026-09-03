import { describe, expect, it } from "vitest";
import {
  computeProratedFirstMonthTotals,
  computeProratedLastMonthTotals,
  leaseEndProration,
  leaseStartProration,
  prorationMonthLabel,
} from "@/lib/lease-first-period-proration";

describe("lease-first-period-proration", () => {
  it("prorates a mid-month start from M/D/YYYY lease dates", () => {
    const proration = leaseStartProration("9/22/2026");
    expect(proration.prorated).toBe(true);
    expect(proration.billableDays).toBe(9);
    expect(proration.daysInMonth).toBe(30);

    const totals = computeProratedFirstMonthTotals({
      monthlyRent: 800,
      monthlyUtilities: 200,
      leaseStart: "9/22/2026",
      leaseEnd: "12/1/2026",
    });
    expect(totals.applies).toBe(true);
    expect(totals.proratedRent).toBe(240);
    expect(totals.proratedUtilities).toBe(60);
    expect(totals.total).toBe(300);
  });

  it("matches ISO and slash-formatted lease starts", () => {
    const iso = computeProratedFirstMonthTotals({
      monthlyRent: 800,
      monthlyUtilities: 200,
      leaseStart: "2026-09-22",
      leaseEnd: "2026-12-01",
    });
    const slash = computeProratedFirstMonthTotals({
      monthlyRent: 800,
      monthlyUtilities: 200,
      leaseStart: "9/22/2026",
      leaseEnd: "12/1/2026",
    });
    expect(slash).toEqual(iso);
  });

  it("prorates with explicit daily rates when the room uses set per day", () => {
    const totals = computeProratedFirstMonthTotals({
      monthlyRent: 800,
      monthlyUtilities: 200,
      leaseStart: "9/22/2026",
      leaseEnd: "12/1/2026",
      method: "daily_rate",
      dailyRentRate: 30,
      dailyUtilitiesRate: 7,
    });
    expect(totals.applies).toBe(true);
    expect(totals.proratedRent).toBe(270);
    expect(totals.proratedUtilities).toBe(63);
    expect(totals.total).toBe(333);
  });
});

describe("computeProratedLastMonthTotals", () => {
  it("prorates the partial final month by day count", () => {
    // Dec 1 2027 is 1 of December's 31 days.
    const totals = computeProratedLastMonthTotals({
      monthlyRent: 825,
      monthlyUtilities: 200,
      leaseEnd: "2027-12-01",
    });
    expect(totals.applies).toBe(true);
    expect(totals.billableDays).toBe(1);
    expect(totals.daysInMonth).toBe(31);
    expect(totals.proratedRent).toBe(26.61);
    expect(totals.proratedUtilities).toBe(6.45);
    expect(totals.total).toBe(33.06);
    expect(totals.monthLabel).toBe("December 2027");
  });

  it("bills the partial final month per day when the room prorates by daily rate", () => {
    const totals = computeProratedLastMonthTotals({
      monthlyRent: 825,
      monthlyUtilities: 0,
      leaseEnd: "12/1/2027",
      method: "daily_rate",
      dailyRentRate: 35,
    });
    expect(totals.proratedRent).toBe(35);
    expect(totals.total).toBe(35);
  });

  it("bills a daily-priced room's final month at its headline daily rate", () => {
    const totals = computeProratedLastMonthTotals({
      monthlyRent: 0,
      monthlyUtilities: 0,
      leaseEnd: "2026-06-12",
      dailyBasisRate: 55,
    });
    expect(totals.applies).toBe(true);
    expect(totals.proratedRent).toBe(660);
  });

  it("does not apply when the term ends on the last day of a month", () => {
    expect(
      computeProratedLastMonthTotals({ monthlyRent: 825, monthlyUtilities: 200, leaseEnd: "2027-11-30" })
        .applies,
    ).toBe(false);
    expect(leaseEndProration("2027-11-30").prorated).toBe(false);
  });

  it("does not apply to a daily-priced stay that ends inside its own first month", () => {
    // The ledger bills that term once as its first period, so a second last-month charge
    // would double-bill it — the document has to skip it on the same condition.
    const totals = computeProratedLastMonthTotals({
      monthlyRent: 0,
      monthlyUtilities: 0,
      leaseEnd: "2026-09-28",
      dailyBasisRate: 55,
      endsInsideFirstMonth: true,
    });
    expect(totals.applies).toBe(false);
    expect(totals.total).toBe(0);
  });

  it("prefers ledger amounts over recomputing them", () => {
    const totals = computeProratedLastMonthTotals({
      monthlyRent: 825,
      monthlyUtilities: 200,
      leaseEnd: "2027-12-01",
      ledgerProratedLastMonthRent: 35,
      ledgerProratedLastMonthUtilities: 0,
    });
    expect(totals.proratedRent).toBe(35);
    expect(totals.proratedUtilities).toBe(0);
    expect(totals.total).toBe(35);
  });
});

describe("prorationMonthLabel", () => {
  it("names the calendar month regardless of the date format", () => {
    expect(prorationMonthLabel("2026-09-22")).toBe("September 2026");
    expect(prorationMonthLabel("9/22/2026")).toBe("September 2026");
  });

  it("is empty for an unparseable date rather than guessing one", () => {
    expect(prorationMonthLabel("Filled at placement")).toBe("");
    expect(prorationMonthLabel(undefined)).toBe("");
  });
});
