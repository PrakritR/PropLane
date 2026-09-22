// @vitest-environment jsdom
// The catalog vendor record page (PLAN-0920-1058, area 1a follow-up) moves off
// a hand-built PortalRecordSectionChrome (items/groups/description) onto the
// record-sections registry's own "vendorCatalog" kind, and its own icon-only
// header (Add to your vendors / Email / Share, or Open when already added)
// instead of a single labeled "Add"/"Added" Button. Mounting the whole
// ManagerVendorsPanel needs a large storage/workspace mock surface it already
// carries in other suites (vendor-list-sections.test.tsx), so this suite
// tests the two pieces directly: the registry output + the header icon row
// it feeds, and ManagerVendorCatalogDetail's own no-subtext record cards. The
// panel's click -> clipboard / mailto / navigate wiring is verified by source
// assertion, the same pattern vendor-list-sections.test.tsx already uses for
// this file's other behavior.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { recordSections } from "@/lib/portals/record-sections";
import { PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { ManagerVendorCatalogDetail } from "@/components/portal/pro-vendor-catalog-detail";
import type { AxisCatalogVendor } from "@/lib/axis-vendor-catalog";

afterEach(() => cleanup());

const panelSource = readFileSync("src/components/portal/pro-vendors-panel.tsx", "utf8");

const VENDOR: AxisCatalogVendor = {
  catalogId: "axis-catalog-plumbing-nw",
  name: "Northwest Plumbing Co",
  trade: "Plumbing",
  city: "Seattle",
  zip: "98101",
  phone: "555-010-0100",
  email: "hello@nwplumbing.test",
  description: "Licensed plumber serving the metro area.",
  hourlyCents: 9500,
  serviceCents: 18500,
};

describe("vendorCatalog record-sections registry entry", () => {
  it("has the Vendor/Work own groups and an icon-only add/email/share header", () => {
    const sections = recordSections("manager", "vendorCatalog", { basePath: "/portal" });
    const ownGroupLabels = sections.groups.map((g) => g.label).filter(Boolean);
    expect(ownGroupLabels).toEqual(["Vendor", "Work"]);
    expect(sections.headerActions.map((a) => a.id)).toEqual(["add", "email", "share"]);
    expect(sections.headerActions.map((a) => a.label)).toEqual(["Add to your vendors", "Email", "Share"]);
  });

  it("resolves a catalog id's tab hrefs under /vendors (query-string routed)", () => {
    const sections = recordSections("manager", "vendorCatalog", { basePath: "/portal" });
    const overview = sections.groups[0]!.items.find((i) => i.id === "overview")!;
    const pricing = sections.groups[0]!.items.find((i) => i.id === "pricing")!;
    expect(overview.href("axis-catalog-plumbing-nw")).toBe("/portal/vendors?tab=catalog&catalog=axis-catalog-plumbing-nw");
    expect(pricing.href("axis-catalog-plumbing-nw")).toBe(
      "/portal/vendors?tab=catalog&catalog=axis-catalog-plumbing-nw&detailTab=pricing",
    );
  });
});

describe("catalog record header icons", () => {
  it("renders Add to your vendors, Email, Share — Add first — by accessible name", () => {
    const sections = recordSections("manager", "vendorCatalog", { basePath: "/portal" });
    const onAction = vi.fn();
    render(<PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onAction} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Add to your vendors", "Email", "Share"]);
    fireEvent.click(screen.getByRole("button", { name: "Add to your vendors" }));
    expect(onAction).toHaveBeenCalledWith("add");
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onAction).toHaveBeenCalledWith("share");
  });

  it("swaps the first icon to Open when the catalog vendor is already on the roster", () => {
    // Same swap pro-vendors-panel.tsx applies to catalogSections.headerActions
    // when catalogRosterMatch is set — never mutates the registry's own array.
    const sections = recordSections("manager", "vendorCatalog", { basePath: "/portal" });
    const withRosterMatch = sections.headerActions.map((action) =>
      action.id === "add" ? { ...action, id: "open", label: "Open" } : action,
    );
    render(<PortalRecordHeaderIconActions actions={withRosterMatch} onAction={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Open", "Email", "Share"]);
    // The registry's own array is untouched by the panel's derived swap.
    expect(sections.headerActions.map((a) => a.id)).toEqual(["add", "email", "share"]);
  });
});

describe("catalog record header wiring in the panel (source-verified)", () => {
  it("swaps add for an Open icon pointed at the roster vendor's own page", () => {
    expect(panelSource).toContain('action.id === "add" ? { id: "open", label: "Open", icon: ArrowUpRight } : action');
    expect(panelSource).toContain('navigate(vendorDetailHref(basePath, catalogRosterMatch.id, "overview"))');
  });

  it("Email opens mailto and Share copies the catalog link and toasts", () => {
    expect(panelSource).toContain("window.location.assign(`mailto:${catalogDetail.email}`)");
    expect(panelSource).toContain("navigator.clipboard.writeText(");
    expect(panelSource).toContain("showToast(\"Vendor link copied.\")");
  });

  it("no longer hand-builds the rail from VENDOR_RAIL_GROUPS", () => {
    expect(panelSource).not.toContain("VENDOR_RAIL_GROUPS");
    expect(panelSource).not.toContain("VENDOR_DETAIL_TAB_DESCRIPTIONS");
    expect(panelSource).toContain('recordSections("manager", "vendorCatalog"');
    expect(panelSource).toContain("sections={catalogChromeSections}");
  });

  it("no longer renders a labeled Add/Added Button for the catalog page header", () => {
    expect(panelSource).not.toContain('data-attr="vendor-catalog-add"');
    expect(panelSource).not.toContain('{catalogRosterMatch ? "Added" : "Add"}');
  });
});

describe("ManagerVendorCatalogDetail overview", () => {
  it("renders the four record cards with a Trade fact", () => {
    render(<ManagerVendorCatalogDetail catalogId={VENDOR.catalogId} vendor={VENDOR} tab="overview" />);
    for (const title of ["Business", "Contact", "About", "Your work together"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText("Trade")).toBeTruthy();
    expect(screen.getByText("Plumbing")).toBeTruthy();
  });

  it("reads 'Not yet' by default and 'Yes' when inRoster is set", () => {
    const { rerender } = render(
      <ManagerVendorCatalogDetail catalogId={VENDOR.catalogId} vendor={VENDOR} tab="overview" />,
    );
    const section = screen.getByText("Your work together").closest("section")!;
    expect(within(section).getByText("Not yet")).toBeTruthy();
    rerender(<ManagerVendorCatalogDetail catalogId={VENDOR.catalogId} vendor={VENDOR} tab="overview" inRoster />);
    const sectionAfter = screen.getByText("Your work together").closest("section")!;
    expect(within(sectionAfter).getByText("Yes")).toBeTruthy();
  });
});
