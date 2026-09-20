import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AXIS_VENDOR_CATALOG } from "@/lib/axis-vendor-catalog";
import { parseVendorDirectoryTab, vendorCatalogDetailHref, vendorListHref } from "@/lib/portal-detail-routes";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("vendor list sections", () => {
  it("routes Your vendors vs PropLane vendors on the list query", () => {
    expect(vendorListHref("/portal")).toBe("/portal/vendors");
    expect(vendorListHref("/portal", "catalog")).toBe("/portal/vendors?tab=catalog");
    expect(vendorCatalogDetailHref("/portal", "axis-catalog-plumbing-nw")).toBe(
      "/portal/vendors?tab=catalog&catalog=axis-catalog-plumbing-nw",
    );
    expect(parseVendorDirectoryTab("catalog")).toBe("catalog");
    expect(parseVendorDirectoryTab("yours")).toBe("yours");
    expect(parseVendorDirectoryTab(null)).toBe("yours");
  });

  it("lists the PropLane catalog with rates and a click-through card", () => {
    const nw = AXIS_VENDOR_CATALOG.find((row) => row.name === "Northwest Plumbing Co");
    expect(nw?.hourlyCents).toBe(9500);
    expect(nw?.serviceCents).toBe(18500);
    expect(nw?.description).toMatch(/Licensed plumber/);
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    expect(panel).toContain('label: "Your vendors"');
    expect(panel).toContain('label: "PropLane vendors"');
    expect(panel).toContain("ManagerVendorCatalogDetail");
    const form = read("src/components/portal/pro-vendor-form-modal.tsx");
    expect(form).toContain("vendor-use-proplane");
    const detail = read("src/components/portal/pro-vendor-catalog-detail.tsx");
    expect(detail).toContain("Hourly");
    expect(detail).toContain("Typical service");
    expect(detail).toContain("vendor-catalog-add");
  });

  it("keeps vendor-list hooks above the detail return", () => {
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    const retry = panel.indexOf("const retryVendors = useCallback");
    const detailReturn = panel.indexOf("if (routeVendorId)");
    expect(retry).toBeGreaterThan(-1);
    expect(detailReturn).toBeGreaterThan(retry);
  });

  it("opens add vendor on Invite by, then contact, then houses", () => {
    const form = read("src/components/portal/pro-vendor-form-modal.tsx");
    const addBlock = form.slice(form.indexOf('id: "invite"'), form.indexOf("const current = Math.min"));
    expect(addBlock).toContain('id: "invite"');
    expect(addBlock).toContain('id: "contact"');
    expect(addBlock).toContain('id: "properties"');
    expect(addBlock).toContain('id: "trades"');
    expect(addBlock).toContain('id: "rates"');
    expect(addBlock.indexOf('id: "invite"')).toBeLessThan(addBlock.indexOf('id: "contact"'));
    expect(addBlock.indexOf('id: "contact"')).toBeLessThan(addBlock.indexOf('id: "properties"'));
    expect(addBlock).toContain('label: "What they do"');
    expect(form).toContain("Use a PropLane vendor");
    expect(form).toContain("TypicalPriceFields");
    expect(form).toContain("vendor-share-on-proplane");
  });
});
