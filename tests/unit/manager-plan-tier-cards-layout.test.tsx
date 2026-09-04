/**
 * @vitest-environment jsdom
 *
 * AXI-128 — "there is no reason to scroll down. have it horizontal. view all
 * three plans at once. for website view."
 *
 * The three plan cards were a single-column grid at every width, so on a desktop
 * browser comparing Free / Pro / Business meant scrolling past each in turn.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ManagerPlanTierCards } from "@/components/auth/manager-plan-tier-cards";
import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";

afterEach(cleanup);

function renderCards() {
  return render(
    <ManagerPlanTierCards
      tiers={MANAGER_PLAN_TIERS}
      billing="monthly"
      selectedTierId="pro"
      onSelectTier={() => {}}
    />,
  );
}

describe("plan chooser layout", () => {
  it("puts the three plans side by side from md up", () => {
    const { container } = renderCards();
    const grid = container.querySelector(".grid");
    expect(grid).toBeTruthy();
    expect(grid?.className).toContain("md:grid-cols-3");
  });

  it("stays one column on a phone, where three across would be unreadable", () => {
    const { container } = renderCards();
    const grid = container.querySelector(".grid");
    // No unprefixed multi-column class — the 3-up is breakpoint-gated only.
    expect(grid?.className).not.toMatch(/(^|\s)grid-cols-[23]/);
  });

  it("gives every card the full column height so the row reads as one band", () => {
    const { container } = renderCards();
    const cards = container.querySelectorAll(".auth-plan-tier-card");
    expect(cards.length).toBe(MANAGER_PLAN_TIERS.length);
    for (const card of cards) expect(card.className).toContain("h-full");
  });

  it("still renders all three plans", () => {
    const { container } = renderCards();
    expect(container.querySelectorAll(".auth-plan-tier-card").length).toBe(3);
  });
});
