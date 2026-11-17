import { describe, expect, it } from "vitest";
import { bucketSeries } from "@/lib/dashboard-kpis";
import { chargePaidAmount, isChargePaid, ledgerRowIsRevenue } from "@/lib/charge-paid";
import { summarizeFinancialActivity } from "@/lib/reports/financial-activity-totals";
import {
  pendingTabApplicationCount,
  pendingTabApplications,
  residentsLivingToday,
  scopeApplicationsLikeThePage,
} from "@/lib/dashboard-agreement";
import { countApplicationsByTab } from "@/lib/rental-application/in-progress-application";
import { dashboardOccupancyFromSnapshot } from "@/lib/dashboard-occupancy";
import type { DemoApplicantRow } from "@/data/demo-portal";

const period = { start: new Date(2026, 10, 1).getTime(), end: new Date(2026, 11, 1).getTime(), label: "Nov" };
const ms = (y: number, m: number, d: number) => new Date(y, m, d).getTime();

type C = { id: string; amountLabel: string; balanceLabel: string; status: string; paidAt?: string; due: number };
const charges: C[] = [
  // Due in November, paid early in October.
  { id: "a", amountLabel: "$1,000.00", balanceLabel: "$0.00", status: "paid", paidAt: "2026-10-28T10:00:00Z", due: ms(2026, 10, 1) },
  // Due in November, paid late in December.
  { id: "b", amountLabel: "$800.00", balanceLabel: "$0.00", status: "paid", paidAt: "2026-12-03T10:00:00Z", due: ms(2026, 10, 5) },
  // Due in October, paid in November: not November's rent.
  { id: "c", amountLabel: "$700.00", balanceLabel: "$0.00", status: "paid", paidAt: "2026-11-02T10:00:00Z", due: ms(2026, 9, 1) },
  // Due in November, unpaid.
  { id: "d", amountLabel: "$500.00", balanceLabel: "$500.00", status: "pending", due: ms(2026, 10, 9) },
];

describe("Rent collected never exceeds due", () => {
  it("reads both over the period's charges by due date", () => {
    const collected = bucketSeries(charges, [period], (c) => c.due, (c) => chargePaidAmount(c))[0]!;
    const due = bucketSeries(charges, [period], (c) => c.due, (c) => Number(c.amountLabel.replace(/[^0-9.]/g, "")))[0]!;
    expect(due).toBe(2300);
    expect(collected).toBe(1800);
    expect(collected).toBeLessThanOrEqual(due);
  });

  it("has one paid predicate: paid, or a payment time; never a cancelled or refunded charge", () => {
    expect(isChargePaid({ status: "paid" })).toBe(true);
    expect(isChargePaid({ status: "pending", paidAt: "2026-11-02" })).toBe(true);
    expect(isChargePaid({ status: "pending" })).toBe(false);
    expect(isChargePaid({ status: "refunded", paidAt: "2026-11-02" })).toBe(false);
    expect(chargePaidAmount({ status: "partially_paid", amountLabel: "$1,000", balanceLabel: "$400" })).toBe(600);
  });
});

describe("cash-flow revenue reads the same classification", () => {
  it("counts a resident payment the chart left unclassified; never a deposit", () => {
    const row = (over: Record<string, unknown>) => ({
      id: "r", date: "2026-11-02", amountCents: 100000, categoryCode: "rent_income", accountType: "unclassified",
      entryType: "payment", source: "Resident payment", ...over,
    });
    expect(ledgerRowIsRevenue(row({}))).toBe(true);
    expect(ledgerRowIsRevenue(row({ categoryCode: "security_deposit" }))).toBe(false);
    const summary = summarizeFinancialActivity([row({}) as never]);
    expect(summary.months["2026-11"]?.revenueCents).toBe(100000);
  });
});

describe("Residents equals occupancy people today", () => {
  it("is the snapshot's people figure, not signed leases", () => {
    const days = [{ dayKey: "2026-11-17", occupied: 22, inHouse: 22, total: 30, houses: [] }];
    const occ = dashboardOccupancyFromSnapshot({ days }, "2026-11-17", []);
    expect(occ?.occupiedToday).toBe(22);
    expect(residentsLivingToday(occ)).toBe(occ?.occupiedToday);
    expect(residentsLivingToday(null)).toBeNull();
  });
});

describe("Applications ready equals the Pending tab", () => {
  const row = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, bucket: "pending", stage: "Submitted", propertyId: undefined, ...over }) as unknown as DemoApplicantRow;
  const rows = [row("1"), row("2", { propertyId: "p1" }), row("3", { bucket: "approved" }), row("4", { mergedInto: "1" })];
  it("keeps rows with no property and counts what the page counts", () => {
    const scoped = scopeApplicationsLikeThePage(rows, {
      isBookingResidencyRow: () => false,
      visible: () => true,
      inWorkspace: () => true,
    });
    expect(pendingTabApplications(scoped)).toHaveLength(2);
    expect(pendingTabApplicationCount(scoped)).toBe(countApplicationsByTab(scoped).pending);
    expect(pendingTabApplicationCount(scoped)).toBe(2);
  });
});
