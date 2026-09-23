import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/portal/pro-vendor-catalog-detail.tsx", "utf8");

describe("catalog vendor detail layout", () => {
  it("uses ReviewSection/ReviewRow record-page cards, not the old Preview/Field primitives", () => {
    expect(source).toContain('data-attr="vendor-catalog-overview"');
    expect(source).toContain("ReviewSection");
    expect(source).toContain("ReviewRow");
    expect(source).not.toContain("function Preview");
    expect(source).not.toContain("function Field");
    expect(source).not.toContain('tab === "profile"');
    expect(source).not.toContain("vendor-catalog-profile");
  });

  it("keeps catalog history empty and rates truthful", () => {
    expect(source).toContain('k="Completed jobs" v="0"');
    expect(source).toContain('k="Ratings from your jobs" v="—"');
    expect(source).toContain('row.hourlyCents == null ? "—"');
    expect(source).toContain('data-attr={`vendor-catalog-empty-${tab}`}');
  });

  it("Overview's 'In your vendors' fact reads the inRoster prop", () => {
    expect(source).toContain("inRoster?: boolean");
    expect(source).toContain('inRoster ? "Yes" : "Not yet"');
  });
});
