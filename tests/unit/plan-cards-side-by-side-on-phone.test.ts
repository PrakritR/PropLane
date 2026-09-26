import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * PRP-314 originally kept the three plans side by side (horizontal snap
 * scroll) on a phone. C178 (captain-requested reversal, 2026-09) replaced
 * that with a stacked full-width column on phone — a comparison page is
 * still comparable when each full card is readable without a sideways
 * swipe, and the phone-only accordion under it now carries the side-by-side
 * comparison instead. Desktop's 3-column grid is unchanged.
 *
 * PLAN-0920-1400 moved the portal's own plan cards off the Billing & plan
 * page and behind the Adjust plan sheet (`pro-plan-adjust-sheet.tsx`), as two
 * stacked, always-visible rows inside a modal rather than a horizontal
 * scroller — there is no longer a comparable "grid vs. scroller" surface to
 * guard there, so only the pricing page keeps this assertion.
 */
describe("plan cards on the pricing page (PRP-314 → C178)", () => {
  it("src/app/(public)/pricing/page.tsx stacks full-width on a phone and grids on desktop", () => {
    const source = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    const start = source.indexOf('data-attr="pricing-plan-stack"');
    expect(start).toBeGreaterThan(-1);
    const tag = source.slice(source.lastIndexOf("<div", start), start);
    expect(tag).toContain("flex-col");
    expect(tag).not.toContain("overflow-x-auto");
    expect(tag).not.toContain("snap-x");
    expect(tag).toContain("md:grid-cols-3");
  });

  it("phone gets a per-plan compare accordion; desktop keeps the single table", () => {
    const source = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    expect(source).toContain("ComparePlanAccordion");
    expect(source).toContain('data-attr="pricing-compare-phone"');
  });

  it("phone shows a sticky Get started bar", () => {
    const source = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    expect(source).toContain('data-attr="pricing-sticky-cta"');
    expect(source).toContain("MobileStickyCta");
  });

  it("the Adjust plan sheet lists both paid tiers as rows, not a card grid", () => {
    const source = readFileSync("src/components/portal/pro-plan-adjust-sheet.tsx", "utf8");
    expect(source).toContain('(["pro", "business"] as const)');
    expect(source).not.toContain("billing-plan-scroller");
  });
});
