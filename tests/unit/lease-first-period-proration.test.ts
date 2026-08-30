import { describe, expect, it } from "vitest";
import {
  computeProratedFirstMonthTotals,
  leaseStartProration,
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
});
