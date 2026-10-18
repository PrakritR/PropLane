// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PricingCards,
  ServicePricingCard,
  TIER_CTA,
} from "@/components/marketing/site/pricing-cards";
import PricingPage from "@/app/(public)/pricing/page";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import {
  MANAGER_PLAN_TIERS,
  managerPlanFeatureSummary,
} from "@/data/manager-plan-tiers";
import { MANAGED_INCLUDES } from "@/lib/marketing/managed-service";

vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));
afterEach(cleanup);

const optionNames = ["Free", "Pro", "Business", "We manage it for you"];

describe("all four pricing options", () => {
  it.each(["overview", "full"] as const)(
    "shows every choice together in the %s variant without software/service tabs",
    (variant) => {
      render(<PricingCards variant={variant} />);
      const row = screen.getByRole("region", { name: "Pricing options" });
      expect(row).not.toHaveAttribute("tabindex");
      expect(
        within(row)
          .getAllByRole("article")
          .map((article) => article.getAttribute("aria-label")),
      ).toEqual(optionNames);
      expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
      for (const id of ["free", "pro", "business"] as const) {
        const card = within(row).getByRole("article", {
          name: id === "free" ? "Free" : id === "pro" ? "Pro" : "Business",
        });
        expect(
          within(card).getByText(
            formatRateCardUsd(RATE_CARD[id].floorMonthlyCents),
          ),
        ).toBeVisible();
        expect(
          within(card).getByRole("link", { name: TIER_CTA[id].label }),
        ).toHaveAttribute("href", TIER_CTA[id].href);
      }
      const managed = within(row).getByRole("article", {
        name: "We manage it for you",
      });
      expect(managed).toHaveClass("pl-pricing-managed");
      expect(within(managed).getByText("Custom")).toBeVisible();
      expect(
        within(managed).getByRole("link", { name: "Talk to us" }),
      ).toHaveAttribute("href", "/#contact");
    },
  );

  it.each(["overview", "full"] as const)(
    "uses the annual rate-card amounts in %s without changing the service quote",
    (variant) => {
      render(<PricingCards annual variant={variant} />);
      for (const [id, name] of [
        ["pro", "Pro"],
        ["business", "Business"],
      ] as const) {
        const card = screen.getByRole("article", { name });
        expect(
          within(card).getByText(
            formatRateCardUsd(RATE_CARD[id].floorAnnualCents),
          ),
        ).toBeVisible();
        expect(within(card).getByText("/yr")).toBeVisible();
      }
      expect(
        within(
          screen.getByRole("article", { name: "We manage it for you" }),
        ).getByText("Custom"),
      ).toBeVisible();
    },
  );

  it("keeps the homepage overview short while retaining all four choices", () => {
    render(<PricingCards variant="overview" />);
    for (const article of screen.getAllByRole("article")) {
      expect(article).toHaveClass("pl-pricing-compact");
      const items = within(article).getAllByRole("listitem");
      expect(items.length).toBeGreaterThanOrEqual(5);
      expect(items.length).toBeLessThanOrEqual(7);
    }
  });

  it("takes each software inclusion from the shared plan definition and enforced rate card", () => {
    render(<PricingCards variant="overview" />);
    for (const tier of MANAGER_PLAN_TIERS) {
      const card = screen.getByRole("article", { name: tier.label });
      expect(
        within(card)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(managerPlanFeatureSummary(tier).map((feature) => feature.text));
      expect(tier.features[0].text).toContain(
        String(RATE_CARD[tier.id].includedDoors),
      );
    }
    expect(
      within(screen.getByRole("article", { name: "Business" })).getByText(
        "Everything in Pro, plus",
      ),
    ).toBeVisible();
    const managed = screen.getByRole("article", {
      name: "We manage it for you",
    });
    expect(
      within(managed)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(MANAGED_INCLUDES.map((item) => item.title));
  });

  it("shows all four options for an old service-tab URL and preserves billing and comparison", async () => {
    render(
      await PricingPage({
        searchParams: Promise.resolve({ view: "service", billing: "annual" }),
      }),
    );
    const row = screen.getByRole("region", { name: "Pricing options" });
    expect(
      within(row)
        .getAllByRole("article")
        .map((article) => article.getAttribute("aria-label")),
    ).toEqual(optionNames);
    expect(
      within(row).getByText(formatRateCardUsd(RATE_CARD.pro.floorAnnualCents)),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Monthly" })).toHaveAttribute(
      "href",
      "/pricing",
    );
    expect(screen.getByRole("link", { name: /Annual/ })).toHaveAttribute(
      "href",
      "/pricing?billing=annual",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "We manage it for you.",
    );
    expect(
      document.querySelector('[data-attr="pricing-sticky-cta-link"]'),
    ).toHaveAttribute("href", "/#contact");
    expect(
      document.querySelector('[data-attr="pricing-sticky-cta-link"]'),
    ).toHaveTextContent("Talk to us");
    expect(screen.getByText("Compare every feature")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("preserves the detailed service card for the long service page", () => {
    render(<ServicePricingCard />);
    expect(screen.getByRole("link", { name: "Talk to us" })).toHaveAttribute(
      "href",
      "/#contact",
    );
    expect(
      screen.getByRole("link", { name: "See how it works" }),
    ).toHaveAttribute("href", "/#service");
    for (const item of MANAGED_INCLUDES)
      expect(screen.getByText(`${item.title}.`)).toBeInTheDocument();
  });
});
