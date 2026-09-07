import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * PRP-350 — manager dashboard phone tap targets must be ≥44px tall (min-h-11).
 * Month chips, "View all" overflow links, and the messaging-setup banner link
 * were measured at 15–23px on a 390px phone.
 */
describe("PRP-350 dashboard phone tap targets", () => {
  it("pads cash-flow month and range chips to min-h-11", () => {
    const chart = read("src/components/portal/monthly-profit-chart.tsx");
    expect(chart).toContain("monthly-profit-month-");
    // The range chips live in the shared CashflowRangeToggle (extracted for the
    // profitability card, PRP-278); its default data-attr prefix is the one the
    // cash-flow chart used to spell out inline.
    expect(chart).toContain('dataAttrPrefix = "cashflow-range"');
    // Month + range buttons both use the 44px floor (PRP-350).
    const monthBtn = chart.slice(chart.indexOf("{points.map((p, i)"));
    expect(monthBtn).toContain("min-h-11");
    const rangeBtn = chart.slice(
      chart.indexOf("export function CashflowRangeToggle"),
      chart.indexOf("{points.map((p, i)"),
    );
    expect(rangeBtn).toContain("min-h-11");
    expect(rangeBtn).toContain("min-w-11");
  });

  it("pads attention-group View all links on manager and resident dashboards", () => {
    for (const file of [
      "src/components/portal/pro-dashboard.tsx",
      "src/components/portal/resident-dashboard.tsx",
    ]) {
      const src = read(file);
      expect(src).toContain('data-attr="dashboard-attention-view-all"');
      expect(src).toMatch(/dashboard-attention-view-all[\s\S]*min-h-11/);
    }
  });

  it("pads the messaging setup banner link", () => {
    const banner = read("src/components/portal/messaging-setup-banner.tsx");
    expect(banner).toContain('data-attr="manager-messaging-setup-banner-link"');
    expect(banner).toMatch(/manager-messaging-setup-banner-link[\s\S]*min-h-11/);
  });
});
