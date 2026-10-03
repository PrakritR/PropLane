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
});
