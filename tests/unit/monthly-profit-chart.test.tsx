// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
afterEach(cleanup);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `count` months ending Oct 2026: revenue 1000 + 100·i, expense 400, so every total is easy to hand-check. */
function series(count: number, profitOf?: (i: number) => number) {
  return Array.from({ length: count }, (_, i) => {
    const offset = count - 1 - i; // months before Oct 2026
    const m = 9 - offset;
    const year = 2026 + Math.floor(m / 12);
    const month = ((m % 12) + 12) % 12;
    const revenue = 1000 + 100 * i;
    const expense = 400;
    return { key: `${year}-${String(month + 1).padStart(2, "0")}`, label: MONTHS[month], revenue, expense, profit: profitOf ? profitOf(i) : revenue - expense };
  });
}
const points24 = series(24);

const TILE_IDS = { revenue: "rev", rev: "rev", expenses: "exp", net: "net", margin: "margin" } as const;
const tile = (name: keyof typeof TILE_IDS) => document.querySelector(`[data-attr="cashflow-kpi-${TILE_IDS[name]}"]`) as HTMLElement;
const svg = () => document.querySelector('[data-attr="cashflow-chart"] svg') as SVGSVGElement;
/** x (in the default 900px viewBox) in the middle of the i-th visible month column. */
const columnX = (i: number, count: number) => 56 + ((900 - 56 - 12) / count) * (i + 0.5);

describe("Cash flow chart", () => {
  it("totals the selected range with the delta against the prior equal-length period", () => {
    render(<MonthlyProfitChart points={points24} />);
    // last 6 months (i = 18..23): revenue 18,300; expenses 2,400; net 15,900. Prior 6 (i = 12..17): revenue 14,700.
    expect(within(tile("revenue")).getByText("$18,300")).toBeTruthy();
    expect(within(tile("revenue")).getByText("+$3,600 vs prior period")).toBeTruthy();
    expect(within(tile("expenses")).getByText("$2,400")).toBeTruthy();
    expect(within(tile("expenses")).getByText("+$0.00 vs prior period")).toBeTruthy();
    expect(within(tile("net")).getByText("$15,900")).toBeTruthy();
    expect(within(tile("net")).getByText("+$3,600 vs prior period")).toBeTruthy();
    expect(within(tile("margin")).getByText("86.9%")).toBeTruthy(); // 15,900 / 18,300
  });

  it("recomputes totals for 12M and YTD", () => {
    render(<MonthlyProfitChart points={points24} />);
    fireEvent.click(screen.getByRole("tab", { name: "12M" }));
    // i = 12..23: 12,000 + 100·(12+…+23 = 210) = 33,000
    expect(within(tile("revenue")).getByText("$33,000")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "YTD" }));
    // 2026 Jan–Oct = i = 14..23: 10,000 + 100·185 = 28,500
    expect(within(tile("revenue")).getByText("$28,500")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^\w{3} 2026: Revenue/ })).toHaveLength(10);
  });

  it("names the range when there is no prior period to compare", () => {
    render(<MonthlyProfitChart points={series(8)} defaultRangeMonths={12} />);
    expect(within(tile("revenue")).getByText("Last 12 months")).toBeTruthy();
    expect(screen.queryByText(/vs prior period/)).toBeNull();
  });

  it("isolates a series from the switch and refits the axis", () => {
    render(<MonthlyProfitChart points={points24} />);
    expect(document.querySelectorAll('path[data-series="rev"]').length).toBe(6);
    expect(document.querySelectorAll('path[data-series="exp"]').length).toBe(6);
    expect(document.querySelectorAll('circle[data-series="net-dot"]').length).toBe(6);
    const axisBefore = Array.from(svg().querySelectorAll("text")).map(t => t.textContent);
    fireEvent.click(screen.getByRole("tab", { name: "Expenses" }));
    expect(document.querySelectorAll('path[data-series="rev"]').length).toBe(0);
    expect(document.querySelectorAll('path[data-series="exp"]').length).toBe(6);
    expect(document.querySelectorAll('circle[data-series="net-dot"]').length).toBe(0);
    expect(Array.from(svg().querySelectorAll("text")).map(t => t.textContent)).not.toEqual(axisBefore);
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(document.querySelectorAll('path[data-series="rev"]').length).toBe(6);
  });

  it("isolates a series from its KPI tile, fades the others, and clicking again returns to All", () => {
    render(<MonthlyProfitChart points={points24} />);
    fireEvent.click(tile("net"));
    expect(tile("net").getAttribute("aria-pressed")).toBe("true");
    expect(tile("revenue").className).toContain("opacity-50");
    expect(tile("margin").className).not.toContain("opacity-50");
    expect(document.querySelectorAll('path[data-series="rev"]').length).toBe(0);
    expect(document.querySelectorAll('circle[data-series="net-dot"]').length).toBe(6);
    expect(screen.getByRole("tab", { name: "Net profit" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tile("net"));
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelectorAll('path[data-series="rev"]').length).toBe(6);
    expect(tile("margin").tagName).not.toBe("BUTTON");
  });

  it("shows the hovered month in the tiles and tooltip, then returns to the range totals on leave", () => {
    render(<MonthlyProfitChart points={points24} />);
    fireEvent.mouseMove(svg(), { clientX: columnX(5, 6) }); // Oct 2026, i = 23
    expect(within(tile("revenue")).getByText("$3,300")).toBeTruthy();
    expect(within(tile("revenue")).getByText("Oct 2026")).toBeTruthy();
    const tip = document.querySelector('[data-attr="cashflow-tooltip"]') as HTMLElement;
    expect(within(tip).getByText("Oct 2026")).toBeTruthy();
    expect(within(tip).getByText("Net profit")).toBeTruthy();
    fireEvent.mouseMove(svg(), { clientX: columnX(0, 6) }); // May 2026, i = 18
    expect(within(tile("revenue")).getByText("$2,800")).toBeTruthy();
    expect(within(tile("revenue")).getByText("May 2026")).toBeTruthy();
    fireEvent.mouseLeave(svg());
    expect(document.querySelector('[data-attr="cashflow-tooltip"]')).toBeNull();
    expect(within(tile("revenue")).getByText("$18,300")).toBeTruthy();
  });

  it("lists only the visible series in the tooltip", () => {
    render(<MonthlyProfitChart points={points24} />);
    fireEvent.click(tile("rev"));
    fireEvent.mouseMove(svg(), { clientX: columnX(2, 6) });
    const tip = document.querySelector('[data-attr="cashflow-tooltip"]') as HTMLElement;
    expect(within(tip).getByText("Revenue")).toBeTruthy();
    expect(within(tip).queryByText("Expenses")).toBeNull();
    expect(within(tip).queryByText("Net profit")).toBeNull();
  });

  it("draws a negative net profit below the solid $0 baseline", () => {
    render(<MonthlyProfitChart points={series(6, i => (i === 5 ? -700 : 300))} />);
    const baseline = Array.from(svg().querySelectorAll("line")).find(l => !l.getAttribute("stroke-dasharray"));
    const zeroY = Number(baseline?.getAttribute("y1"));
    const dots = Array.from(document.querySelectorAll('circle[data-series="net-dot"]')).map(c => Number(c.getAttribute("cy")));
    expect(dots[0]).toBeLessThan(zeroY);
    expect(dots[5]).toBeGreaterThan(zeroY);
    expect(Array.from(svg().querySelectorAll("text")).some(t => t.textContent?.startsWith("−$"))).toBe(true);
  });

  it("uses the same months for the tiles, bars and axis (no stray month)", () => {
    render(<MonthlyProfitChart points={points24} />);
    const columns = screen.getAllByRole("button", { name: /^\w{3} 20\d\d: Revenue/ });
    expect(columns.map(c => c.getAttribute("aria-label")?.split(":")[0])).toEqual(["May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026"]);
    expect(columns.at(-1)?.getAttribute("aria-label")).toBe("Oct 2026: Revenue $3,300, Expenses $400.00, Net profit $2,900");
    const axis = Array.from(svg().querySelectorAll("text")).map(t => t.textContent);
    expect(axis).toEqual(expect.arrayContaining(["May", "Jun", "Jul", "Aug", "Sep", "Oct"]));
    expect(axis).not.toContain("Nov");
    expect(axis).not.toContain("Dec");
    expect(screen.queryByText("Net profit", { selector: "div.font-semibold" })).toBeNull();
  });

  it("opens the month on click and on Enter, and reveals it on keyboard focus", () => {
    const select = vi.fn();
    render(<MonthlyProfitChart points={points24} onMonthSelect={select} />);
    const sep = screen.getByRole("button", { name: /^Sep 2026:/ });
    fireEvent.focus(sep);
    expect(within(tile("revenue")).getByText("Sep 2026")).toBeTruthy();
    fireEvent.click(sep);
    expect(select).toHaveBeenCalledWith("2026-09");
    fireEvent.keyDown(screen.getByRole("button", { name: /^Aug 2026:/ }), { key: "Enter" });
    expect(select).toHaveBeenCalledWith("2026-08");
  });

  it("uses the same columns in the table and routes selected months", () => {
    const select = vi.fn();
    render(<MonthlyProfitChart points={points24} onMonthSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: "Show table" }));
    expect(screen.getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Month", "Revenue", "Expenses", "Net profit", "Margin"]);
    fireEvent.click(screen.getByRole("button", { name: "May 2026" }));
    expect(select).toHaveBeenCalledWith("2026-05");
  });

  it("hides the summary tiles on overview and shows an empty state only with no data", () => {
    const { rerender } = render(<MonthlyProfitChart points={points24} hideSummary />);
    expect(document.querySelector('[data-attr="cashflow-hero"]')).toBeNull();
    rerender(<MonthlyProfitChart points={[]} />);
    expect(screen.getByText("No cash flow data yet.")).toBeTruthy();
  });
});
