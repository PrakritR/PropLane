// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
afterEach(cleanup);
const points = [
  { key: "2026-04", label: "Apr", revenue: 600, expense: 100, profit: 500 },
  { key: "2026-05", label: "May", revenue: 800, expense: 120, profit: 680 },
  { key: "2026-06", label: "Jun", revenue: 1150, expense: 90, profit: 1060 },
];
describe("Cash flow comparison", () => {
  it("shows revenue, expenses, profit and margin together", () => {
    render(<MonthlyProfitChart points={points} />);
    expect(screen.getByText("$1,150")).toBeTruthy(); expect(screen.getByText("$90.00")).toBeTruthy();
    expect(screen.getByText("$1,060")).toBeTruthy(); expect(screen.getByText("92.2%")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Revenue" })).toBeNull();
  });
  it("uses the same values in the table and routes selected months", () => {
    const select = vi.fn(); render(<MonthlyProfitChart points={points} onMonthSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: "Show table" }));
    fireEvent.click(screen.getByRole("button", { name: "2026-04" }));
    expect(select).toHaveBeenCalledWith("2026-04"); expect(screen.getByRole("table")).toBeTruthy();
  });
  it("updates the readout on keyboard focus and hides duplicate summary on overview", () => {
    const { rerender } = render(<MonthlyProfitChart points={points} />);
    fireEvent.focus(screen.getByRole("button", { name: "2026-04, open activity" }));
    expect(screen.getByText("$600.00")).toBeTruthy();
    rerender(<MonthlyProfitChart points={points} hideSummary />);
    expect(document.querySelector('[data-attr="cashflow-hero"]')).toBeNull();
  });
  it("shows an empty state only when no monthly data exists", () => {
    render(<MonthlyProfitChart points={[]} />); expect(screen.getByText("No cash flow data yet.")).toBeTruthy();
  });
});
