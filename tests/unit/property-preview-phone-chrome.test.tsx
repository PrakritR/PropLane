// @vitest-environment jsdom
/**
 * Phone polish for the manager's property pages (PLAN mobile-step-tabs-1004,
 * part 6): the list ends at its last row, the preview's sections are underline
 * tabs, the map starts short, and the sticky bar is one slim row. The manager
 * preview is still the public listing page: only chrome changes, and the public
 * page's own bar is untouched.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { ListingLocationBlock } from "@/components/marketing/listing-location-block";
import { PortalRecordPhoneTabs } from "@/components/portal/portal-record-section-chrome";
import type { MockProperty } from "@/data/types";
import type { ListingRichContent } from "@/data/listing-rich-content";

vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));
vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => null,
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));
vi.mock("@/hooks/use-listing-map-coords", () => ({
  useListingMapCoords: () => ({ coords: null, loading: true }),
}));
vi.mock("@/components/marketing/listing-location-map", () => ({
  ListingLocationMap: () => null,
}));

const property = {
  id: "prop-1",
  title: "Lakeview Studio",
  address: "2100 Westlake Ave N, Seattle, WA 98109",
  neighborhood: "South Lake Union",
  contactSmsPhone: "+12064420188",
  contactWorkEmail: "leasing@mail.proplane.space",
} as unknown as MockProperty;

const rich = {
  heroTagline: "",
  heroHousePhotoUrls: [],
  priceRangeLabel: "From $1,450/mo",
  startingRentLabel: "$1,450/mo",
  pricingBreakdown: [],
  floorPlans: [
    {
      name: "Floor 1",
      rooms: Array.from({ length: 5 }, (_, i) => ({
        id: `room-${i + 1}`,
        name: `Room ${i + 1}`,
        price: "$1,450/mo",
        availability: i < 2 ? "Available now" : "Occupied",
        modal: { photoUrls: [] },
      })),
    },
  ] as unknown as ListingRichContent["floorPlans"],
  bathrooms: [],
  sharedSpaces: [],
  leaseBasics: [],
  amenities: [],
  bundlesText: "",
  bundleCards: [],
  quickFacts: [],
} as unknown as ListingRichContent;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("manager preview — slim phone sticky bar", () => {
  it("is one row: price and availability, then Apply and Tour; no contact pills", () => {
    render(<ListingDetailSections property={property} rich={rich} portalEmbedded managerPreviewChrome hidePortalSubnav />);
    const bar = document.querySelector('[data-attr="listing-sticky-bar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.hasAttribute("data-slim")).toBe(true);
    expect(bar.textContent).toContain("$1,450/mo");
    expect(bar.textContent).toContain("5 rooms · 2 available");
    expect(bar.querySelector('[data-attr="listing-web-apply"]')?.textContent).toContain("Apply");
    expect(bar.querySelector('[data-attr="listing-web-tour"]')?.textContent).toContain("Tour");
    // the full names stay for a screen reader
    expect(bar.querySelector('[data-attr="listing-web-apply"] .sr-only')?.textContent).toBe("Apply long term");
    expect(bar.querySelector('[data-attr="listing-web-tour"] .sr-only')?.textContent).toBe("Schedule tour");
    // Email moved into the record header menu
    expect(bar.querySelector('[data-attr="listing-sticky-contact"]')).toBeNull();
    expect(bar.querySelector('[data-attr="listing-sticky-email"]')).toBeNull();
  });

  it("leaves the public listing page's own two-row bar as it was", () => {
    render(<ListingDetailSections property={property} rich={rich} />);
    const bar = document.querySelector('[data-attr="listing-sticky-bar"]') as HTMLElement;
    expect(bar.hasAttribute("data-slim")).toBe(false);
    expect(bar.querySelector('[data-attr="listing-sticky-email"]')).not.toBeNull();
    expect(bar.textContent).toContain("Apply long term");
    expect(bar.textContent).toContain("Schedule tour");
  });
});

describe("manager preview — short map on a phone", () => {
  it("starts short and expands to the full map on tap", () => {
    render(<ListingLocationBlock property={property as never} embedded shortOnPhone />);
    expect(screen.getByLabelText("Loading map").className).toContain("max-lg:!h-[7.5rem]");
    fireEvent.click(screen.getByRole("button", { name: "Expand map" }));
    expect(screen.getByLabelText("Loading map").className).not.toContain("max-lg:!h-[7.5rem]");
    expect(screen.queryByRole("button", { name: "Expand map" })).toBeNull();
  });

  it("is always the full map when the short phone map is not asked for (public page, desktop)", () => {
    render(<ListingLocationBlock property={property as never} embedded />);
    expect(screen.getByLabelText("Loading map").className).not.toContain("max-lg:!h-[7.5rem]");
    expect(screen.queryByRole("button", { name: "Expand map" })).toBeNull();
  });
});

describe("PortalRecordPhoneTabs — the sections as underline tabs", () => {
  const items = [
    { id: "preview", label: "Preview", href: "/portal/properties/all/p1/preview" },
    { id: "application", label: "Applications", href: "/portal/properties/all/p1/application" },
    { id: "lease", label: "Lease", href: "/portal/properties/all/p1/lease" },
  ];

  it("draws every section as a link tab, the active one marked", () => {
    render(<PortalRecordPhoneTabs items={items} activeId="application" ariaLabel="Property sections" />);
    const nav = screen.getByRole("navigation", { name: "Property sections" });
    expect(nav.querySelectorAll("a").length).toBe(3);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Applications");
    expect(nav.querySelector('[data-attr="record-section-tab-lease"]')?.className).toContain("border-b-2");
  });
});

describe("Properties list — ends at the last row", () => {
  const panel = readFileSync(resolve(process.cwd(), "src/components/portal/pro-house-properties-panel.tsx"), "utf8");

  it("adds no second bottom inset on a phone: the page scroller already pads the nav", () => {
    const surface = panel.slice(panel.indexOf("<PortalRecordListSurface"), panel.indexOf("bulkCount={selectedIds.size}"));
    expect(surface).toContain('className="mt-0 max-lg:pb-0"');
    expect(panel).toContain('cn(PORTAL_LIST_PAGE_BODY, "pb-0 max-lg:pb-0 lg:pb-0")');
  });
});
