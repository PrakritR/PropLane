// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
afterEach(cleanup);

/** A desktop (fine pointer, wide window) so the Filter control renders its anchored popover. */
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("pointer: fine"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })),
  });
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `count` months ending Oct 2026, with revenue / expense chosen per month index. */
function flow(count: number, revenueOf: (i: number) => number, expenseOf: (i: number) => number) {
  return Array.from({ length: count }, (_, i) => {
    const offset = count - 1 - i; // months before Oct 2026
    const m = 9 - offset;
    const year = 2026 + Math.floor(m / 12);
    const month = ((m % 12) + 12) % 12;
    const revenue = revenueOf(i);
    const expense = expenseOf(i);
    return { key: `${year}-${String(month + 1).padStart(2, "0")}`, label: MONTHS[month], revenue, expense, profit: revenue - expense };
  });
}
/** Revenue 1000 + 100·i, expense 400, so every total is easy to hand-check. */
const series = (count: number) => flow(count, i => 1000 + 100 * i, () => 400);
const points24 = series(24);

const TILE_IDS = { revenue: "rev", rev: "rev", expenses: "exp", net: "net", margin: "margin" } as const;
const tile = (name: keyof typeof TILE_IDS) => document.querySelector(`[data-attr="cashflow-kpi-${TILE_IDS[name]}"]`) as HTMLElement;
const svg = () => document.querySelector('[data-attr="cashflow-chart"] svg') as SVGSVGElement;
const seriesPaths = (name: string) => document.querySelectorAll(`path[data-series="${name}"]`);
/** x (in the default 900px viewBox) in the middle of the i-th visible month column. */
const columnX = (i: number, count: number) => 56 + ((900 - 56 - 12) / count) * (i + 0.5);

const usd = (text: string) => Number(text.replace(/[$,]/g, "").replace("−", "-"));
/** The running totals each month's accessible label reads, oldest first. */
function runningFromAria() {
  return screen.getAllByRole("button", { name: /^\w{3} 20\d\d: Running revenue/ }).map(el => {
    const m = el.getAttribute("aria-label")!.match(/Running revenue (\S+), running expenses (\S+), running net profit (\S+)$/)!;
    return { rev: usd(m[1]), exp: usd(m[2]), net: usd(m[3]) };
  });
}

/** Open the Filter popover, run `change` inside it, then close it (filters apply on close, like every list). */
async function withFilter(change: () => void) {
  fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
  await waitFor(() => expect(document.querySelector('[data-attr="portal-filter-dropdown-panel"]')).toBeTruthy());
  change();
  fireEvent.click(screen.getByRole("button", { name: "Close filters" }));
  await waitFor(() => expect(document.querySelector('[data-attr="portal-filter-dropdown-panel"]')).toBeNull());
}
/** Pick `name` from the Period / Show dropdown inside the open Filter popover. */
function pick(group: string, name: string) {
  fireEvent.click(screen.getByRole("button", { name: group }));
  const option = within(screen.getByRole("listbox", { name: group })).getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 5, clientY: 5 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 5, clientY: 5 });
}

describe("Cash flow chart", () => {
  it("puts the period beside the title and the switches in one Filter popover", () => {
    render(<MonthlyProfitChart points={points24} />);
    expect(screen.getByRole("heading", { name: /^Cash flow/ }).textContent).toBe("Cash flowLast 6 months");
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /^Filter/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show table" })).toBeTruthy();
  });

  it("the Filter trigger is the shared icon beside Show table, with the active state on the icon", async () => {
    render(<MonthlyProfitChart points={points24} />);
    const filter = screen.getByRole("button", { name: "Filter" });
    expect(filter.textContent?.trim()).toBe("");
    expect(filter.parentElement!.parentElement).toBe(screen.getByRole("button", { name: "Show table" }).parentElement);
    await withFilter(() => pick("Period", "12 months"));
    expect(screen.getByRole("button", { name: "Filter · 1 active" })).toBeTruthy();
  });

  it("Period and Show are dropdowns, never pills", async () => {
    render(<MonthlyProfitChart points={points24} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await waitFor(() => expect(document.querySelector('[data-attr="portal-filter-dropdown-panel"]')).toBeTruthy());
    expect(screen.queryAllByRole("radiogroup")).toHaveLength(0);
    for (const group of ["Period", "Show"]) {
      const trigger = screen.getByRole("button", { name: group });
      expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    }
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(within(screen.getByRole("listbox", { name: "Show" })).getAllByRole("option").map(o => o.textContent?.replace("✓", ""))).toEqual(["All", "Revenue", "Expenses", "Profit"]);
  });

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

  it("recomputes totals and the period label for 12 months and Year to date from the filter", async () => {
    render(<MonthlyProfitChart points={points24} />);
    await withFilter(() => pick("Period", "12 months"));
    // i = 12..23: 12,000 + 100·(12+…+23 = 210) = 33,000
    expect(within(tile("revenue")).getByText("$33,000")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Cash flow/ }).textContent).toBe("Cash flowLast 12 months");
    await withFilter(() => pick("Period", "Year to date"));
    // 2026 Jan–Oct = i = 14..23: 10,000 + 100·185 = 28,500
    expect(within(tile("revenue")).getByText("$28,500")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Cash flow/ }).textContent).toBe("Cash flowYear to date");
    expect(screen.getAllByRole("button", { name: /^\w{3} 2026: Running revenue/ })).toHaveLength(10);
  });

  it("names the period when there is no earlier period to compare", () => {
    render(<MonthlyProfitChart points={series(8)} defaultRangeMonths={12} />);
    expect(within(tile("revenue")).getByText("Last 12 months")).toBeTruthy();
    expect(screen.queryByText(/vs prior period/)).toBeNull();
  });

  it("shows no prior-period delta when the prior period is all zero", () => {
    // The first 6 of 12 months have no revenue and no expense; the last 6 do.
    const quiet = flow(12, i => (i < 6 ? 0 : 1000), i => (i < 6 ? 0 : 300));
    render(<MonthlyProfitChart points={quiet} />);
    expect(within(tile("revenue")).getByText("$6,000")).toBeTruthy();
    expect(screen.queryByText(/vs prior period/)).toBeNull();
    expect(within(tile("revenue")).getByText("Last 6 months")).toBeTruthy();
    expect(within(tile("expenses")).getByText("Last 6 months")).toBeTruthy();
    expect(within(tile("net")).getByText("Last 6 months")).toBeTruthy();
  });

  it("draws running totals: revenue and expenses never fall, and net is their difference", () => {
    // Expenses are 0 in two months (flat), revenue always positive.
    render(<MonthlyProfitChart points={flow(24, i => 1000 + 100 * i, i => (i % 3 === 0 ? 0 : 400))} />);
    const rows = runningFromAria();
    expect(rows).toHaveLength(6);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rev).toBeGreaterThanOrEqual(rows[i - 1].rev);
      expect(rows[i].exp).toBeGreaterThanOrEqual(rows[i - 1].exp);
    }
    for (const r of rows) expect(r.net).toBe(r.rev - r.exp);
    // i = 18..23 → expense 0 at i = 18 and 21: running expenses stay flat across those months.
    expect(rows[0].exp).toBe(0);
    expect(rows[3].exp).toBe(rows[2].exp);
    // Running revenue from the start of the period: 2,800 + 2,900 = 5,700 …
    expect(rows[0].rev).toBe(2800);
    expect(rows[1].rev).toBe(5700);
    expect(rows[5].rev).toBe(18300);
    // The drawn lines climb as well: SVG y never grows from one month to the next.
    for (const name of ["rev", "exp"]) {
      const ys = (seriesPaths(name)[0].getAttribute("d") ?? "").match(/,(-?[\d.]+)/g)!.map(v => Number(v.slice(1)));
      expect(ys).toHaveLength(6);
      for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-9);
    }
  });

  it("draws one line per series, a 10% area for revenue and expenses, a dashed net line, and end dots only", () => {
    render(<MonthlyProfitChart points={points24} />);
    expect(seriesPaths("rev")).toHaveLength(1);
    expect(seriesPaths("exp")).toHaveLength(1);
    expect(seriesPaths("net")).toHaveLength(1);
    expect(seriesPaths("net")[0].getAttribute("stroke-dasharray")).toBeTruthy();
    expect(seriesPaths("net")[0].getAttribute("stroke-width")).toBe("2.5");
    for (const name of ["rev-area", "exp-area"]) {
      expect(seriesPaths(name)).toHaveLength(1);
      expect(seriesPaths(name)[0].getAttribute("fill-opacity")).toBe("0.1");
    }
    expect(seriesPaths("net-area")).toHaveLength(0);
    for (const name of ["rev-dot", "exp-dot", "net-dot"]) {
      const dots = document.querySelectorAll(`circle[data-series="${name}"]`);
      expect(dots).toHaveLength(1);
      expect(dots[0].getAttribute("r")).toBe("4.5");
      expect(dots[0].getAttribute("stroke-width")).toBe("2");
    }
  });

  it("isolates a series from the Filter popover's Show field and refits the axis", async () => {
    render(<MonthlyProfitChart points={points24} />);
    const axisBefore = Array.from(svg().querySelectorAll("text")).map(t => t.textContent);
    await withFilter(() => pick("Show", "Expenses"));
    expect(seriesPaths("rev")).toHaveLength(0);
    expect(seriesPaths("exp")).toHaveLength(1);
    expect(seriesPaths("net")).toHaveLength(0);
    expect(document.querySelectorAll('circle[data-series="net-dot"]')).toHaveLength(0);
    expect(Array.from(svg().querySelectorAll("text")).map(t => t.textContent)).not.toEqual(axisBefore);
    expect(tile("expenses").getAttribute("aria-pressed")).toBe("true");
    await withFilter(() => pick("Show", "All"));
    expect(seriesPaths("rev")).toHaveLength(1);
    expect(seriesPaths("net")).toHaveLength(1);
  });

  it("changes the period and the series in one pass through the popover", async () => {
    render(<MonthlyProfitChart points={points24} />);
    await withFilter(() => {
      pick("Period", "12 months");
      pick("Show", "Profit");
    });
    expect(screen.getAllByRole("button", { name: /^\w{3} 20\d\d: Running revenue/ })).toHaveLength(12);
    expect(seriesPaths("net")).toHaveLength(1);
    expect(seriesPaths("rev")).toHaveLength(0);
    expect(tile("net").getAttribute("aria-pressed")).toBe("true");
  });

  it("isolates a series from its KPI tile, fades the others, and clicking again returns to All", () => {
    render(<MonthlyProfitChart points={points24} />);
    fireEvent.click(tile("net"));
    expect(tile("net").getAttribute("aria-pressed")).toBe("true");
    expect(tile("revenue").className).toContain("opacity-50");
    expect(tile("margin").className).not.toContain("opacity-50");
    expect(seriesPaths("rev")).toHaveLength(0);
    expect(document.querySelectorAll('circle[data-series="net-dot"]')).toHaveLength(1);
    fireEvent.click(tile("net"));
    expect(tile("net").getAttribute("aria-pressed")).toBe("false");
    expect(seriesPaths("rev")).toHaveLength(1);
    expect(tile("margin").tagName).not.toBe("BUTTON");
  });

  it("shows the running total and the month's own amount in the tooltip, then the period totals on leave", () => {
    render(<MonthlyProfitChart points={points24} />);
    fireEvent.mouseMove(svg(), { clientX: columnX(5, 6) }); // Oct 2026, i = 23
    expect(within(tile("revenue")).getByText("$3,300")).toBeTruthy(); // tiles switch to that month
    expect(within(tile("revenue")).getByText("Oct 2026")).toBeTruthy();
    const tip = document.querySelector('[data-attr="cashflow-tooltip"]') as HTMLElement;
    expect(within(tip).getByText("Oct 2026 · running total")).toBeTruthy();
    expect(within(tip).getByText("$18,300")).toBeTruthy(); // running revenue
    expect(within(tip).getByText("+$3,300 this month")).toBeTruthy();
    expect(within(tip).getByText("$2,400")).toBeTruthy(); // running expenses
    expect(within(tip).getByText("+$400.00 this month")).toBeTruthy();
    expect(within(tip).getByText("$15,900")).toBeTruthy(); // running net
    expect(within(tip).getByText("+$2,900 this month")).toBeTruthy();
    expect(document.querySelector('[data-attr="cashflow-guide"]')).toBeTruthy();
    fireEvent.mouseMove(svg(), { clientX: columnX(0, 6) }); // May 2026, i = 18
    const tipMay = document.querySelector('[data-attr="cashflow-tooltip"]') as HTMLElement;
    expect(within(tipMay).getByText("May 2026 · running total")).toBeTruthy();
    expect(within(tipMay).getByText("+$2,800 this month")).toBeTruthy();
    expect(within(tile("revenue")).getByText("$2,800")).toBeTruthy();
    fireEvent.mouseLeave(svg());
    expect(document.querySelector('[data-attr="cashflow-tooltip"]')).toBeNull();
    expect(document.querySelector('[data-attr="cashflow-guide"]')).toBeNull();
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

  it("lets the running net dip below the solid $0 baseline and the axis follows", () => {
    // Revenue 100/month, expenses 100 then 500 from month 2: running net = 0, −400, −800 …
    render(<MonthlyProfitChart points={flow(6, () => 100, i => (i === 0 ? 100 : 500))} />);
    const baseline = Array.from(svg().querySelectorAll("line")).find(l => !l.getAttribute("stroke-dasharray"));
    const zeroY = Number(baseline?.getAttribute("y1"));
    const endNet = Number(document.querySelector('circle[data-series="net-dot"]')?.getAttribute("cy"));
    expect(endNet).toBeGreaterThan(zeroY);
    expect(Array.from(svg().querySelectorAll("text")).some(t => t.textContent?.startsWith("−$"))).toBe(true);
    expect(runningFromAria().at(-1)?.net).toBe(-2000);
  });

  it("uses the same months for the tiles, lines and axis (no stray month)", () => {
    render(<MonthlyProfitChart points={points24} />);
    const columns = screen.getAllByRole("button", { name: /^\w{3} 20\d\d: Running revenue/ });
    expect(columns.map(c => c.getAttribute("aria-label")?.split(":")[0])).toEqual(["May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026"]);
    expect(columns.at(-1)?.getAttribute("aria-label")).toBe("Oct 2026: Running revenue $18,300, running expenses $2,400, running net profit $15,900");
    const axis = Array.from(svg().querySelectorAll("text")).map(t => t.textContent);
    expect(axis).toEqual(expect.arrayContaining(["May", "Jun", "Jul", "Aug", "Sep", "Oct"]));
    expect(axis).not.toContain("Nov");
    expect(axis).not.toContain("Dec");
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

  it("keeps the table view as monthly rows and routes selected months", () => {
    const select = vi.fn();
    render(<MonthlyProfitChart points={points24} onMonthSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: "Show table" }));
    expect(screen.getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Month", "Revenue", "Expenses", "Net profit", "Margin"]);
    expect(screen.getAllByRole("row")).toHaveLength(7); // header + 6 months
    expect(within(screen.getAllByRole("row")[6]).getByText("$3,300")).toBeTruthy(); // Oct's own revenue, not a running total
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
