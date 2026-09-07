import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * PRP-314: the three plans must be comparable side by side on a phone, not
 * stacked so only one is on screen. Both plan surfaces — the public /pricing
 * page and the portal's Billing & plan panel — render the cards in a
 * horizontal snap scroller below the desktop breakpoint, where the grid
 * takes over.
 */
const SURFACES = [
  { file: "src/app/(public)/pricing/page.tsx", attr: "pricing-plan-scroller", desktop: "md:grid-cols-3" },
  { file: "src/components/portal/pro-plan.tsx", attr: "billing-plan-scroller", desktop: "lg:grid-cols-3" },
] as const;

describe("plan cards stay side by side on a phone (PRP-314)", () => {
  for (const surface of SURFACES) {
    it(`${surface.file} scrolls horizontally on a phone and grids on desktop`, () => {
      const source = readFileSync(surface.file, "utf8");
      const start = source.indexOf(`data-attr="${surface.attr}"`);
      expect(start).toBeGreaterThan(-1);
      const tag = source.slice(source.lastIndexOf("<div", start), start);
      expect(tag).toContain("overflow-x-auto");
      expect(tag).toContain("snap-x");
      expect(tag).toContain("[&>*]:shrink-0");
      expect(tag).toContain(surface.desktop);
    });
  }
});
