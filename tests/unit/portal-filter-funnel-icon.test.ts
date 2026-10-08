import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** STD-7: Filter actions use lucide Filter (funnel), not SlidersHorizontal. */
describe("portal filter funnel icon", () => {
  it("portal-filter-sort-sheet uses Filter", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/portal-filter-sort-sheet.tsx"),
      "utf8",
    );
    expect(source).toMatch(/import \{[^}]*\bFilter\b[^}]*\} from "lucide-react"/);
    expect(source).not.toMatch(/\bSlidersHorizontal\b/);
  });

  it("portal-list-control-stack allows Filter in the list-band vocabulary", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/portal-list-control-stack.tsx"),
      "utf8",
    );
    expect(source).toMatch(/Filter, \/\/ Filter \(funnel\)/);
    expect(source).not.toMatch(/SlidersHorizontal, \/\/ Filter/);
  });

  it("marketing product mocks use Filter for list-header Filter actions", () => {
    // Tours / Applications / Leases draw the real Filter popover from a lazy chunk (`demo-popups-lazy-leasing.tsx`);
    // until it arrives the header shows the same funnel icon.
    const source = readFileSync(
      join(process.cwd(), "src/components/marketing/site/product-mock/demo-popups-lazy-leasing.tsx"),
      "utf8",
    );
    expect(source).toMatch(/icon=\{Filter\} label="Filter"/);
    expect(source).not.toMatch(/SlidersHorizontal.*label="Filter"/);
  });
});
