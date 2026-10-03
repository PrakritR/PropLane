// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { invalidateFinancialActivity } from "@/lib/financial-activity-cache";
import { ManagerFinancesOverview } from "@/components/portal/finances/finances-overview";
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
  it("routes deposits to filtered Activity", async () => {
    setup(true); expect((await screen.findByRole("link", { name: /Held deposits/ })).getAttribute("href")).toBe("/portal/financials/activity?category=deposits");
  });
  it("removes pay cards, plan credit and secondary overview cards", async () => {
    setup(true); await screen.findByText("Held deposits");
    for (const name of ["Pay vendors", "Plan & credit", "Recent activity", "Coming up", "Expenses by category", "By property"]) expect(screen.queryByText(name)).toBeNull();
  });
  it("does not invent an available balance when the balance ledger is disabled", async () => {
    setup(false); await screen.findByText("Held deposits"); expect(screen.queryByText("$123")).toBeNull();
  });
  it("shows failed ledger reads as errors, never zero totals", async () => {
    setup(true, true); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Ledger unavailable");
  });
});
