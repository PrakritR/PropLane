// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { invalidateFinancialActivity } from "@/lib/financial-activity-cache";
import { ManagerFinancesOverview } from "@/components/portal/finances/finances-overview";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(enabled: boolean, fail = false) {
  invalidateFinancialActivity(new Event("test-mutation"));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.startsWith("/api/reports/")) return Response.json(fail ? { error: "Ledger unavailable" } : { meta: { summary: JSON.stringify({ heldDepositsCents: 4500, months: {} }) } }, { status: fail ? 500 : 200 });
    if (input.includes("vendor-invoices")) return Response.json({ totals: { owedCents: 900, billCount: 2 } });
    return Response.json({ enabled, availableCents: 12300, pendingCents: 400 });
  }));
  return render(<ManagerFinancesOverview userId="manager" ready propertyId="" period="month" basePath="/portal" propertyOptions={[]} />);
}
describe("Finances simplified overview", () => {
  it("shows the four balances from server responses", async () => {
    setup(true); expect(await screen.findByText("Held deposits")).toBeTruthy();
    // Overview tiles are whole dollars (commit 2e8b13336, studio "$7,700"); exact cents stay in Activity.
    expect(screen.getByText("$45")).toBeTruthy(); expect(screen.getByText("$9")).toBeTruthy();
    expect(screen.getByText("$123")).toBeTruthy(); expect(screen.getByText("$4")).toBeTruthy(); expect(screen.getByText("2 bills")).toBeTruthy();
  });
  it("routes unpaid bills to the one Outgoing list", async () => {
    setup(true); expect((await screen.findByRole("link", { name: /To pay/ })).getAttribute("href")).toBe("/portal/outgoing/to-pay");
  });
  it("routes deposits to the Deposits report", async () => {
    setup(true); expect((await screen.findByRole("link", { name: /Held deposits/ })).getAttribute("href")).toBe("/portal/financials/security-deposits");
  });
  it("removes pay cards, plan credit and secondary overview cards", async () => {
    setup(true); await screen.findByText("Held deposits");
    for (const name of ["Pay vendors", "Plan & credit", "Recent activity", "Coming up", "Expenses by category"]) expect(screen.queryByText(name)).toBeNull();
  });
  it("lists By property only from the ledger rows of the month, and nothing when there are none", async () => {
    setup(true); await screen.findByText("Held deposits");
    expect(screen.queryByText("By property")).toBeNull();
  });
  it("draws one row per property with the month's In and Out taken from the same ledger rows", async () => {
    const date = pacificCalendarDateYmd();
    const rows = [
      { date, amountCents: 545000, categoryCode: "rent_income", accountType: "income", propertyId: "p1", property: "61 Willow Court" },
      { date, amountCents: -31000, categoryCode: "maintenance", accountType: "expense", propertyId: "p1", property: "61 Willow Court" },
      { date, amountCents: 500000, categoryCode: "security_deposit_liability", accountType: "liability", propertyId: "p1", property: "61 Willow Court" },
    ];
    invalidateFinancialActivity(new Event("test-mutation"));
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.startsWith("/api/reports/")) return Response.json({ rows, meta: { summary: JSON.stringify({ heldDepositsCents: 0, months: {} }) } });
      if (input.includes("vendor-invoices")) return Response.json({ totals: { owedCents: 0, billCount: 0 } });
      return Response.json({ enabled: true, availableCents: 0, pendingCents: 0 });
    }));
    render(<ManagerFinancesOverview userId="manager" ready propertyId="" period="month" basePath="/portal" propertyOptions={[]} />);
    expect(await screen.findByText("By property")).toBeTruthy();
    const row = document.querySelector('[data-attr="finances-by-property"] [data-record-row]')!;
    expect(row.textContent).toContain("61 Willow Court");
    expect(row.textContent).toContain("In $5,450");
    expect(row.textContent).toContain("Out $310");
  });
  it("does not invent an available balance when the balance ledger is disabled", async () => {
    setup(false); await screen.findByText("Held deposits"); expect(screen.queryByText("$123")).toBeNull();
  });
  it("shows failed ledger reads as errors, never zero totals", async () => {
    setup(true, true); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Ledger unavailable");
  });
  it("draws the cash flow chart as the dashboard does: period label, period-total tiles, Filter and running total", async () => {
    setup(true);
    await screen.findByText("Held deposits");
    expect(document.querySelector('[data-attr="cashflow-period"]')?.textContent).toBe("Last 6 months");
    const hero = document.querySelector('[data-attr="cashflow-hero"]');
    expect(hero).not.toBeNull();
    for (const id of ["rev", "exp", "net", "margin"]) expect(hero!.querySelector(`[data-attr="cashflow-kpi-${id}"]`)).not.toBeNull();
    expect(document.querySelector('[data-attr="cashflow-filter-open"]')).not.toBeNull();
    expect(screen.getByRole("group", { name: "Running total of revenue, expenses and net profit" })).toBeTruthy();
  });
});
