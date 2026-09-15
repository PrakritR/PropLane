/**
 * @vitest-environment node
 *
 * Portfolio import's two Properties entry points: the "all" empty state gets
 * a second action next to Add property, and the header + becomes a two-item
 * menu. `pro-house-properties-panel.tsx` and `pro-properties.tsx` both carry
 * enormous demo/session/workspace dependency graphs that make a full render
 * impractical here, so — matching this suite's existing convention for that
 * file (`share-lead-multi-property-preselect.test.tsx`) — this reads the
 * source for the exact wiring rather than mounting the component tree.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  path.join(process.cwd(), "src/components/portal/pro-house-properties-panel.tsx"),
  "utf8",
);
const properties = readFileSync(path.join(process.cwd(), "src/components/portal/pro-properties.tsx"), "utf8");

describe("Properties empty state — both actions", () => {
  it("offers Import portfolio only alongside Add property, only on the all tab", () => {
    const actions = panel.split("const renderEmptyState = ()")[1]?.slice(0, 4000) ?? "";
    expect(actions).toContain('label: "Add property"');
    expect(actions).toContain('dataAttr: "manager-properties-create"');
    expect(actions).toContain('label: "Import portfolio"');
    expect(actions).toContain('href: "/portal/properties/import"');
    expect(actions).toContain('dataAttr: "properties-empty-import"');
    expect(actions).toContain('activeStage === "all"');
  });
});

describe("Properties header + — Add property / Import portfolio menu", () => {
  it("wraps the primary icon action in a two-item dropdown menu", () => {
    expect(properties).toContain("DropdownMenuTrigger");
    const menu = properties.split("<DropdownMenuContent>")[1]?.split("</DropdownMenu>")[0] ?? "";
    expect(menu).toContain("manager-properties-add-top-property");
    expect(menu).toContain("Add property");
    expect(menu).toContain('data-attr="manager-properties-import"');
    expect(menu).toContain('href="/portal/properties/import"');
    expect(menu).toContain("Import portfolio");
  });

  it("shows a banner above the list for a draft or in-progress import", () => {
    expect(properties).toContain('data-attr="properties-import-banner"');
    expect(properties).toContain('data-attr="properties-import-banner-open"');
    expect(properties).toContain("listPortfolioImports");
  });
});
