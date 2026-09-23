import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AXIS_VENDOR_CATALOG, formatVendorCatalogUsd } from "@/lib/axis-vendor-catalog";
import { parseVendorDetailTab, parseVendorDirectoryTab, vendorCatalogDetailHref, vendorListHref, VENDOR_DETAIL_TABS } from "@/lib/portal-detail-routes";

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
    expect(parseVendorDetailTab("profile")).toBe("overview");
    expect(parseVendorDetailTab("communication")).toBe("communication");
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
    expect(detail).toContain("vendor-catalog-empty-${tab}");
  });

  it("gives catalog entries the same seven-section rail without fabricating private history", () => {
    const panel = read("src/components/portal/pro-vendors-panel.tsx");
    const detail = read("src/components/portal/pro-vendor-catalog-detail.tsx");
    // "services" and "invoices" (PLAN-0921-1029, area 2) are the manager's
    // OWN vendor kind's trimmed picker ids, added additively to this shared
    // type — the catalog kind's own seven sections below are unchanged.
    expect(VENDOR_DETAIL_TABS).toEqual([
      "overview",
      "profile",
      "jobs",
      "pricing",
      "reviews",
      "check-ins",
      "services",
      "invoices",
      "communication",
      "documents",
      "activity",
    ]);
    // The catalog rail is the record-sections registry's own "vendorCatalog"
    // kind (PLAN-0920-1058, area 1a follow-up), not a hand-built rail — a
    // hand-rolled VENDOR_RAIL_GROUPS array would be a regression.
    expect(panel).not.toContain("VENDOR_RAIL_GROUPS");
    expect(panel).toContain('recordSections("manager", "vendorCatalog"');
    expect(panel).toContain("catalogDetailTab");
    expect(detail).not.toContain("readManagerWorkOrderRows");
    expect(detail).not.toContain("residentConfirmation");
    expect(detail).not.toContain("findRosterCatalogMatch");
    expect(detail).toContain('No {tab === "jobs" ? "services" : tab} are available');
  });

  it("keeps absent catalog rates distinct from a genuine zero rate", () => {
    expect(formatVendorCatalogUsd(null)).toBe("—");
    expect(formatVendorCatalogUsd(undefined)).toBe("—");
    expect(formatVendorCatalogUsd(0)).toBe("$0");
  });

  it("uses the manager-owned stable vendor row for private jobs and ratings", () => {
    const summary = read("src/lib/manager-vendor-summary.server.ts");
    expect(summary).toContain("vendor_user_id");
    expect(summary).toContain("row.vendorId === vendorId");
    expect(summary).toContain('row.bucket === "completed"');
    expect(summary).toContain("row.residentConfirmation?.rating");
    expect(summary).not.toContain("vendorRow.name");
    expect(summary).not.toContain("vendorRow.phone");
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
