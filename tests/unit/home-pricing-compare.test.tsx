// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePricingCompare } from "@/components/marketing/home-pricing-compare";
import { ANNUAL_MONTHS_FREE, HOME_COMPARE_ROWS, HOME_PLAN_COLUMNS } from "@/components/marketing/home-pricing-compare-data";
import { COMPARE } from "@/components/marketing/site/pricing-compare-data";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import { MANAGED_CONTACT_HREF } from "@/lib/marketing/managed-service";
import { TIER_CTA } from "@/components/marketing/site/pricing-cards";
import { MANAGER_PLAN_TIERS, PROCESSING_FEES_FEATURE_TEXT } from "@/data/manager-plan-tiers";

vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
afterEach(cleanup);

describe("homepage plan comparison", () => {
  it("lists the four plans with price and action at the top of each column", () => {
    render(<HomePricingCompare />);
    const table = screen.getByRole("table", { name: "Compare plans" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.querySelector("h3")?.textContent).filter(Boolean)).toEqual([
      "Free",
      "Pro",
      "Business",
      "We manage it for you",
    ]);
    expect(within(table).getByText("$0")).toBeInTheDocument();
    expect(within(table).getByText(formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents))).toBeInTheDocument();
    expect(within(table).getByText(formatRateCardUsd(RATE_CARD.business.floorMonthlyCents))).toBeInTheDocument();
    expect(within(table).getByText("Custom", { selector: "strong" })).toBeInTheDocument();
    for (const id of ["free", "pro", "business"] as const) {
      const link = document.querySelector(`[data-attr="pricing-plan-${id}-cta"]`);
      expect(link).toHaveAttribute("href", TIER_CTA[id].href);
      expect(link).toHaveTextContent(TIER_CTA[id].label);
    }
    expect(document.querySelector('[data-attr="pricing-plan-managed-cta"]')).toHaveAttribute("href", MANAGED_CONTACT_HREF);
    expect(document.querySelector('[data-attr="pricing-plan-free-cta"]')).toHaveAttribute("href", TIER_CTA.free.href);
  });

  it("prints the processing-fee note from the named constant, not a position in a feature list", () => {
    // `MANAGER_PLAN_TIERS[0].features[8].text` silently changed wording when a Free-tier feature was reordered,
    // and threw in a server component (taking the home page with it) if the list ever got shorter.
    render(<HomePricingCompare />);
    const note = document.querySelector(".home-compare-note");
    expect(note).toHaveTextContent(`${PROCESSING_FEES_FEATURE_TEXT}.`);
    const source = readFileSync("src/components/marketing/home-pricing-compare.tsx", "utf8");
    expect(source).not.toMatch(/features\[\d+\]/);
    // The same sentence is still what every plan card carries, so the note and the cards cannot drift.
    for (const tier of MANAGER_PLAN_TIERS) {
      expect(tier.features.some((feature) => feature.text === PROCESSING_FEES_FEATURE_TEXT), tier.id).toBe(true);
    }
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

  it("is headed with the top-bar word and offers a Monthly | Annual switch derived from the rate card", () => {
    render(<HomePricingCompare titleId="t" />);
    expect(screen.getByRole("heading", { level: 2, name: "Pricing" })).toHaveAttribute("id", "t");
    const monthly = document.getElementById("home-billing-monthly") as HTMLInputElement;
    const annual = document.getElementById("home-billing-annual") as HTMLInputElement;
    expect(monthly.checked).toBe(true);
    expect(annual.checked).toBe(false);
    expect(screen.getByText(`${ANNUAL_MONTHS_FREE} months free`)).toBeInTheDocument();
    for (const id of ["pro", "business"] as const) {
      const column = HOME_PLAN_COLUMNS.find((c) => c.id === id)!;
      expect(column.monthly.price).toBe(formatRateCardUsd(RATE_CARD[id].floorMonthlyCents));
      expect(column.annual.sub).toBe(`Billed yearly · ${formatRateCardUsd(RATE_CARD[id].floorAnnualCents)}`);
      const perMonth = RATE_CARD[id].floorAnnualCents / 12;
      expect(Number(column.annual.price.replace("$", ""))).toBeCloseTo(perMonth / 100, 2);
    }
  });
});
