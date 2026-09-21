import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * PRP-314: the three plans must be comparable side by side on a phone, not
 * stacked so only one is on screen. The public /pricing page still renders
 * the three-card grid this way.
 *
 * PLAN-0920-1400 moved the portal's own plan cards off the Billing & plan
 * page and behind the Adjust plan sheet (`pro-plan-adjust-sheet.tsx`), as two
 * stacked, always-visible rows inside a modal rather than a horizontal
 * scroller — there is no longer a comparable "grid vs. scroller" surface to
 * guard there, so only the pricing page keeps this assertion.
 */
describe("plan cards stay side by side on a phone (PRP-314)", () => {
  it("src/app/(public)/pricing/page.tsx scrolls horizontally on a phone and grids on desktop", () => {
    const source = readFileSync("src/app/(public)/pricing/page.tsx", "utf8");
    const start = source.indexOf('data-attr="pricing-plan-scroller"');
    expect(start).toBeGreaterThan(-1);
    const tag = source.slice(source.lastIndexOf("<div", start), start);
    expect(tag).toContain("overflow-x-auto");
    expect(tag).toContain("snap-x");
    expect(tag).toContain("[&>*]:shrink-0");
    expect(tag).toContain("md:grid-cols-3");
  });

  it("the Adjust plan sheet lists both paid tiers as rows, not a card grid", () => {
    const source = readFileSync("src/components/portal/pro-plan-adjust-sheet.tsx", "utf8");
    expect(source).toContain('(["pro", "business"] as const)');
    expect(source).not.toContain("billing-plan-scroller");
  });
});
