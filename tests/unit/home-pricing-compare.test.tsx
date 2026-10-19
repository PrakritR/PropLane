// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePricingCompare } from "@/components/marketing/home-pricing-compare";
import { HOME_COMPARE_ROWS, HOME_PLAN_COLUMNS } from "@/components/marketing/home-pricing-compare-data";
import { COMPARE } from "@/components/marketing/site/pricing-compare-data";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import { MANAGED_CONTACT_HREF } from "@/lib/marketing/managed-service";
import { TIER_CTA } from "@/components/marketing/site/pricing-cards";

vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
afterEach(cleanup);

describe("homepage plan comparison", () => {
  it("lists the four plans with price and action at the top of each column", () => {
    render(<HomePricingCompare />);
    const table = screen.getByRole("table", { name: "Compare plans" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent).filter(Boolean)).toEqual([
      "Free$0",
      `Pro${formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents)}/mo`,
      `Business${formatRateCardUsd(RATE_CARD.business.floorMonthlyCents)}/mo`,
      "We manage it for youCustom",
    ]);
    for (const id of ["free", "pro", "business"] as const) {
      const link = document.querySelector(`[data-attr="pricing-plan-${id}-cta"]`);
      expect(link).toHaveAttribute("href", TIER_CTA[id].href);
      expect(link).toHaveTextContent(TIER_CTA[id].label);
    }
    expect(document.querySelector('[data-attr="pricing-plan-managed-cta"]')).toHaveAttribute("href", MANAGED_CONTACT_HREF);
    expect(document.querySelector('[data-attr="pricing-plan-free-cta"]')).toHaveAttribute("href", TIER_CTA.free.href);
  });

  it("shows the same rows in the same order for every plan, every cell a check, a value or an en dash", () => {
    render(<HomePricingCompare />);
    const rows = screen.getAllByRole("row").filter((row) => row.classList.contains("home-compare-row"));
    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual(HOME_COMPARE_ROWS.map((row) => row.label));
    for (const row of rows) {
      const cells = within(row).getAllByRole("cell");
      expect(cells).toHaveLength(HOME_PLAN_COLUMNS.length);
      for (const cell of cells) expect(cell.textContent).toMatch(/^(Included|–Not included|.+)$/);
    }
  });

  it("derives every software cell from the shared COMPARE data and the rate card", () => {
    const all = COMPARE.flatMap((group) => group.rows);
    for (const row of HOME_COMPARE_ROWS) {
      const source = all.find((candidate) => candidate.label === row.label)!;
      expect(row.cells.slice(0, 3)).toEqual(source.cells);
    }
    const residents = HOME_COMPARE_ROWS.find((row) => row.label === "Residents included")!;
    expect(residents.cells.slice(0, 3)).toEqual([RATE_CARD.free.includedDoors, RATE_CARD.pro.includedDoors, RATE_CARD.business.includedDoors].map(String));
  });
});
