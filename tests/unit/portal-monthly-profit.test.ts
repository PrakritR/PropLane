import { describe, expect, it } from "vitest";
import {
  cashflowChartShowMonthLabel,
  cashflowWindowDirection,
  mergeMonthlyCashflow,
  mergeMonthlyProfit,
  parseMoneyLabel,
} from "@/lib/portal-monthly-profit";

describe("portal-monthly-profit", () => {
  it("merges payments and expenses into monthly cashflow", () => {
    const payments = [
      { key: "2026-01", label: "Jan", value: 1000 },
      { key: "2026-02", label: "Feb", value: 500 },
    ];
    const expenses = [
      { key: "2026-01", label: "Jan", value: 200 },
      { key: "2026-02", label: "Feb", value: 800 },
    ];
    expect(mergeMonthlyCashflow(payments, expenses)).toEqual([
      { key: "2026-01", label: "Jan", revenue: 1000, expense: 200, profit: 800 },
      { key: "2026-02", label: "Feb", revenue: 500, expense: 800, profit: -300 },
    ]);
    expect(mergeMonthlyProfit(payments, expenses)).toEqual([
      { key: "2026-01", label: "Jan", profit: 800 },
      { key: "2026-02", label: "Feb", profit: -300 },
    ]);
  });

  it("parses currency labels", () => {
    expect(parseMoneyLabel("$1,234.56")).toBe(1234.56);
  });

  it("colors the window from first point to last, not the scrubbed month", () => {
    expect(cashflowWindowDirection([])).toBe("flat");
    expect(cashflowWindowDirection([600])).toBe("flat");
    expect(cashflowWindowDirection([600, 600, 1150])).toBe("up");
    expect(cashflowWindowDirection([1850, 600])).toBe("down");
  });

  it("throttles 2Y cash flow month labels to every third month", () => {
    expect(cashflowChartShowMonthLabel(0, 24, 24)).toBe(true);
    expect(cashflowChartShowMonthLabel(1, 24, 24)).toBe(false);
    expect(cashflowChartShowMonthLabel(3, 24, 24)).toBe(true);
    expect(cashflowChartShowMonthLabel(23, 24, 24)).toBe(true);
    expect(cashflowChartShowMonthLabel(5, 6, 6)).toBe(true);
  });
});
