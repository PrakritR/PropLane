// @vitest-environment jsdom
/**
 * The listing's phone action bar when the listing offers both stays: Apply, Long term, Short term,
 * Tour (each stay's button opens its own application), and the assistant floats above the bar
 * instead of sharing its row (captain, 2026-10-06).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import type { MockProperty } from "@/data/types";
import type { ListingRichContent } from "@/data/listing-rich-content";

const stays = vi.hoisted(() => ({ short: true }));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  propertyAllowsShortTermRental: () => stays.short,
}));
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


beforeEach(() => {
  stays.short = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bar = () => document.querySelector('[data-attr="listing-sticky-bar"]') as HTMLElement;
const href = (selector: string) => bar().querySelector<HTMLAnchorElement>(selector)?.getAttribute("href") ?? "";

describe("manager preview phone bar with both stays", () => {
  it("shows Apply, Long term, Short term and Tour, each stay opening its own application", () => {
    render(<ListingDetailSections property={property} rich={rich} portalEmbedded managerPreviewChrome hidePortalSubnav />);
    const labels = [...bar().querySelectorAll('[data-attr="listing-sticky-actions"] a')].map((a) => a.querySelector('[aria-hidden]')?.textContent);
    expect(labels).toEqual(["Apply", "Long term", "Short term", "Tour"]);
    expect(href('[data-attr="listing-web-apply-short"]')).toContain("rentalType=short_term");
    expect(href('[data-attr="listing-web-apply-long"]')).toContain("/rent/apply");
    expect(href('[data-attr="listing-web-apply-long"]')).not.toContain("rentalType");
    expect(bar().querySelector('[data-attr="listing-web-apply-long"] .sr-only')?.textContent).toBe("Apply for the long-term stay");
  });

  it("gives the price its own row so four buttons are never squeezed beside it", () => {
    render(<ListingDetailSections property={property} rich={rich} portalEmbedded managerPreviewChrome hidePortalSubnav />);
    expect(bar().querySelector('[data-attr="listing-sticky-actions"]')?.parentElement?.className).toContain("flex-col");
  });

  it("keeps one row and no Long term button when only long term is offered", () => {
    stays.short = false;
    render(<ListingDetailSections property={property} rich={rich} portalEmbedded managerPreviewChrome hidePortalSubnav />);
    expect(bar().querySelector('[data-attr="listing-web-apply-long"]')).toBeNull();
    expect(bar().querySelector('[data-attr="listing-web-apply-short"]')).toBeNull();
    expect(bar().querySelector('[data-attr="listing-sticky-actions"]')?.parentElement?.className).not.toContain("flex-col");
  });
});

describe("the assistant floats above the bar", () => {
  it("neither bar reserves room for it beside the buttons", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/marketing/listing-detail-sections.tsx"), "utf8");
    expect(source).not.toContain("axis-assistant-fab");
  });

  it("globals.css lifts the bubble by the bar's own measured height", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toContain('html:has([data-attr="listing-sticky-bar"]) .axis-assistant-fab');
    expect(css).toContain("var(--listing-sticky-bar-h");
  });

  it("the public page's bar keeps its two rows and still publishes its height", () => {
    render(<ListingDetailSections property={property} rich={rich} />);
    expect(bar().hasAttribute("data-slim")).toBe(false);
    expect(bar().textContent).toContain("Apply long term");
    expect(bar().textContent).toContain("Apply short term");
  });
});
