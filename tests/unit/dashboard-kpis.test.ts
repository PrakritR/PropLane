// The dashboard's KPI maths: periods, flows, stocks, and how a change is worded.
import { describe, expect, it } from "vitest";
import { ageLabel, bucketSeries, dashboardPeriods, kpiDelta, moneyToNumber, stockSeries, toMs, usdWhole } from "@/lib/dashboard-kpis";

// Fri Sep 11 2026, 19:30 local.
const NOW = new Date(2026, 8, 11, 19, 30).getTime();

describe("dashboardPeriods", () => {
  it("months are calendar months, the current one last and partial", () => {
    const p = dashboardPeriods("month", NOW, 8);
    expect(p).toHaveLength(8);
    expect(p[7]!.label).toBe("Sep");
    expect(p[0]!.label).toBe("Feb");
    expect(new Date(p[7]!.start).getDate()).toBe(1);
    expect(p[7]!.end).toBe(new Date(2026, 9, 1).getTime());
    expect(NOW).toBeGreaterThanOrEqual(p[7]!.start);
    expect(NOW).toBeLessThan(p[7]!.end);
  });

  it("weeks run Monday to Sunday", () => {
    const p = dashboardPeriods("week", NOW, 2);
    expect(new Date(p[1]!.start).getDay()).toBe(1);
    expect(new Date(p[1]!.start).getDate()).toBe(7);
    expect(p[1]!.end - p[1]!.start).toBe(7 * 24 * 3600 * 1000);
    expect(p[1]!.label).toBe("Sep 7–Sep 13");
  });

  it("30-day windows end at the end of today and tile backwards", () => {
    const p = dashboardPeriods("30d", NOW, 3);
    expect(p[2]!.end).toBe(new Date(2026, 8, 12).getTime());
    expect(p[1]!.end).toBe(p[2]!.start);
    expect(p[0]!.end).toBe(p[1]!.start);
  });

  it("every week and 30-day boundary is a local midnight across a DST change", () => {
    // Mon Nov 9 2026, the week after US fall-back (Nov 1).
    const afterFallBack = new Date(2026, 10, 9, 12).getTime();
    for (const kind of ["week", "30d"] as const) {
      for (const p of dashboardPeriods(kind, afterFallBack, 8)) {
        expect(new Date(p.start).getHours()).toBe(0);
        expect(new Date(p.end).getHours()).toBe(0);
      }
    }
    const weeks = dashboardPeriods("week", afterFallBack, 2);
    expect(weeks[0]!.start).toBe(new Date(2026, 10, 2).getTime());
    expect(weeks[1]!.start).toBe(new Date(2026, 10, 9).getTime());
  });
});

describe("bucketSeries and stockSeries", () => {
  const periods = dashboardPeriods("month", NOW, 3); // Jul, Aug, Sep
  it("sums a flow into the period its timestamp falls in, dropping the undated", () => {
    const rows = [
      { at: "2026-07-03", v: 100 },
      { at: "2026-08-30", v: 50 },
      { at: "2026-09-01", v: 7 },
      { at: "", v: 999 },
      { at: "2025-01-01", v: 999 },
    ];
    expect(bucketSeries(rows, periods, (r) => toMs(r.at), (r) => r.v)).toEqual([100, 50, 7]);
    expect(bucketSeries(rows, periods, (r) => toMs(r.at))).toEqual([1, 1, 1]);
  });

  it("counts a stock by what existed at each period's end", () => {
    const leases = [
      { signed: "2026-06-15", ended: null },
      { signed: "2026-08-10", ended: null },
      { signed: "2026-07-01", ended: "2026-08-20" },
    ];
    expect(stockSeries(leases, periods, (l) => toMs(l.signed), (l) => toMs(l.ended))).toEqual([2, 2, 2]);
    // Jul: first + third (third ends in Aug) = 2; Aug: first + second (third ended Aug 20) = 2; Sep: 2.
  });

  it("cuts the current period at now, so a lease ending later this month still counts today", () => {
    const leases = [
      { signed: "2026-06-15", ended: "2026-09-25" },
      { signed: "2026-08-10", ended: null },
      { signed: "2026-09-05", ended: null },
    ];
    // Cut at the period's end, the first lease is already over by Sep 30.
    expect(stockSeries(leases, periods, (l) => toMs(l.signed), (l) => toMs(l.ended))).toEqual([1, 2, 2]);
    // Cut at Sep 11 it is still active; past periods keep their own end.
    expect(stockSeries(leases, periods, (l) => toMs(l.signed), (l) => toMs(l.ended), NOW)).toEqual([1, 2, 3]);
    const octoberFirst = new Date(2026, 9, 1).getTime();
    expect(stockSeries(leases, periods, (l) => toMs(l.signed), (l) => toMs(l.ended), octoberFirst)).toEqual([1, 2, 2]);
  });
});

describe("kpiDelta", () => {
  it("words a rise as good and a fall as bad, unless inverted", () => {
    expect(kpiDelta([10, 12], String, "last month")).toEqual({ change: 2, direction: "up", label: "+2 vs last month" });
    expect(kpiDelta([12, 10], String, "last month")).toEqual({ change: -2, direction: "down", label: "−2 vs last month" });
    expect(kpiDelta([10, 12], String, "last month", true).direction).toBe("down");
    expect(kpiDelta([5, 5], String, "last week")).toEqual({ change: 0, direction: "flat", label: "No change vs last week" });
    expect(kpiDelta([5], String, "last week")).toBeNull();
  });

  it("formats money through the caller's formatter", () => {
    expect(kpiDelta([1000, 1340], usdWhole, "last month")!.label).toBe("+$340 vs last month");
  });
});

describe("helpers", () => {
  it("reads money labels and ages", () => {
    expect(moneyToNumber("$1,160.00")).toBe(1160);
    expect(moneyToNumber("nope")).toBe(0);
    expect(usdWhole(1234.6)).toBe("$1,235");
    expect(ageLabel(NOW - 3 * 24 * 3600 * 1000, NOW)).toBe("3 days");
    expect(ageLabel(NOW - 1000, NOW)).toBe("today");
    expect(ageLabel(NOW - 45 * 24 * 3600 * 1000, NOW)).toBe("1 month");
    expect(toMs("not a date")).toBeNull();
  });
});
