import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vendorCatalogDetailHref } from "@/lib/portal-detail-routes";

const source = readFileSync("src/components/portal/pro-vendor-catalog-detail.tsx", "utf8");

describe("catalog vendor detail layout", () => {
  it("uses the approved overview cards and base-path-aware tab actions", () => {
    expect(source).toContain('data-attr="vendor-catalog-overview"');
    expect((source.match(/<Preview icon=/g) ?? []).length).toBe(8);
    expect(source).toContain('tab === "profile"');
    expect(source).not.toContain('tab === "overview" || tab === "profile"');
    expect(source).toContain("vendorCatalogDetailHref(basePath, detailId, \"profile\")");
    expect(vendorCatalogDetailHref("/manager", "catalog-id", "reviews")).toBe("/manager/vendors?tab=catalog&catalog=catalog-id&detailTab=reviews");
  });

  it("keeps catalog history empty and rates truthful", () => {
    expect(source).toContain('title="Your completed jobs" value="0"');
    expect(source).toContain('title="Your job ratings" value="—"');
    expect(source).toContain('value="No ratings from your jobs"');
    expect(source).toContain('row.hourlyCents == null ? "—"');
    expect(source).toContain('data-attr={`vendor-catalog-empty-${tab}`}');
  });
});
