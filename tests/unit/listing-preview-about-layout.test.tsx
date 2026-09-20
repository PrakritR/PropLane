// @vitest-environment jsdom
/**
 * Manager listing preview sits in a pane that is already narrower than the
 * viewport (property rail + portal chrome). The About / price split must follow
 * that pane’s width, not `lg:`, or the 320px renter card shears “About this home”
 * and “9 bedrooms for rent”.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import type { MockProperty } from "@/data/types";
import type { ListingRichContent } from "@/data/listing-rich-content";

vi.mock("@/components/marketing/listing-location-block", () => ({
  ListingLocationBlock: () => null,
}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));
vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => null,
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

const LAYOUT_LINE =
  "Townhouse · Shared home · 3 · 3.5 bathrooms · 1,800 sq ft · 9 bedrooms for rent";

function property(): MockProperty {
  return {
    id: "prop-udistrict",
    title: "Furnished UW Private Rooms at U-District",
    address: "Seattle, WA",
    neighborhood: "University District",
  } as unknown as MockProperty;
}

const rich: ListingRichContent = {
  heroTagline: "Furnished UW Private Rooms at U-District",
  heroOverview:
    "Enjoy comfortable living in a modern 9-bedroom, 3-bathroom townhouse in Seattle’s U-District.",
  heroHousePhotoUrls: [],
  priceRangeLabel: "From $1,050/mo",
  startingRentLabel: "$1,050/mo",
  pricingBreakdown: [],
  floorPlans: [],
  bathrooms: [],
  sharedSpaces: [],
  leaseBasics: [],
  amenities: [],
  bundlesText: "",
  bundleCards: [],
  quickFacts: [{ label: "Property & layout", value: LAYOUT_LINE }],
};

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

describe("listing preview About layout", () => {
  it("prints spaced About copy and the full Property & layout line in the manager preview", () => {
    render(
      <ListingDetailSections
        property={property()}
        rich={rich}
        portalEmbedded
        managerPreviewChrome
        hidePortalSubnav
      />,
    );

    expect(screen.getByRole("heading", { name: "About this home" }).textContent).toBe(
      "About this home",
    );
    expect(screen.getByText(LAYOUT_LINE)).toBeTruthy();
    expect(screen.queryByText(/bedroomsfor/)).toBeNull();
  });

  it("splits About and the price card on the listing pane width, not the viewport", () => {
    const { container } = render(<ListingDetailSections property={property()} rich={rich} />);

    const root = container.querySelector("[data-listing-sections-root]");
    expect(root?.className).toContain("@container");

    const grid = container.querySelector("[data-listing-about-grid]");
    expect(grid?.className).toContain("@min-[900px]:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]");
    expect(grid?.className).not.toContain("lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]");

    const stack = container.querySelector("[data-listing-price-card-stack]");
    expect(stack?.className).toContain("lg:block");
    expect(stack?.className).toContain("@min-[900px]:hidden");

    const rail = container.querySelector("[data-listing-about-grid] > aside");
    expect(rail?.className).toContain("@min-[900px]:block");
    expect(rail?.className).not.toMatch(/(?:^|\s)lg:block(?:\s|$)/);
  });
});
