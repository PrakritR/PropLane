import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Captain Oct 18: compare Free, Pro, Business and managed service in one row. */
describe("four public pricing choices", () => {
  it("uses a focusable phone swipe row and a four-column desktop grid", () => {
    const source = readFileSync("src/components/marketing/site/pricing-cards.tsx", "utf8");
    const css = readFileSync("src/components/marketing/site/pricing-cards.css", "utf8");
    expect(source).toContain('data-attr="pricing-plan-stack"');
    expect(source).toContain('role="region"');
    expect(source).toContain("tabIndex={0}");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("scroll-snap-type: x mandatory");
    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(readFileSync("src/app/(public)/pricing/page.tsx", "utf8")).toContain("<PricingCards annual={annual} />");
  });

  it("phone gets a per-plan compare accordion; desktop keeps the single table", () => {
    const source = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    expect(source).toContain("ComparePlanAccordion");
    expect(source).toContain('data-attr="pricing-compare-phone"');
  });

  it("phone shows a sticky managed-service contact bar", () => {
    const source = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    expect(source).toContain('data-attr="pricing-sticky-cta"');
    expect(source).toContain("MobileStickyCta");
  });

  it("the Adjust plan sheet lists both paid tiers as rows, not a card grid", () => {
    const source = readFileSync("src/components/portal/pro-plan-adjust-sheet.tsx", "utf8");
    expect(source).toContain('(["free", "pro", "business"] as const)');
    expect(source).not.toContain("billing-plan-scroller");
  });
});
