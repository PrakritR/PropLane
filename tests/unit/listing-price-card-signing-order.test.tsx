// @vitest-environment jsdom
/**
 * Captain (2026-09-27): a lease-first listing (`property.signingOrder`,
 * PLAN-0927) must show "Sign lease" on the public listing detail page's
 * price card and mobile sticky bar instead of "Apply" — and, when no
 * application fee is charged up front, the price card's "Application fee"
 * row becomes a "Lease fee" row for the resolved lease-signing fee
 * (never client math — `leaseSigningFeeCents` is the server's own resolved
 * amount). Studio spec: the swap happens even when a listing also charges an
 * application fee — one fee concept in that row.
 *
 * Captain (2026-10-03): the apply door is split by term - "Apply long term" always,
 * "Apply short term" only when the listing offers short stays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
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

function property(overrides: Partial<MockProperty> = {}): MockProperty {
  return {
    id: "prop-1",
    title: "5257 Brooklyn Avenue Northeast",
    address: "5257 Brooklyn Avenue Northeast, Seattle, WA 98105",
    neighborhood: "University District",
    ...overrides,
  } as unknown as MockProperty;
}

function rich(overrides: Partial<ListingRichContent> = {}): ListingRichContent {
  return {
    heroTagline: "",
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
    quickFacts: [],
    ...overrides,
  };
}

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

function priceCard() {
  const el = document.querySelector('[data-attr="listing-price-card"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

function stickyBar() {
  const el = document.querySelector('[data-attr="listing-sticky-bar"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe("public listing price card and sticky bar — signingOrder", () => {
  it("says Apply long term for an application-first listing", () => {
    render(<ListingDetailSections property={property()} rich={rich()} />);
    const apply = priceCard().querySelector('[data-attr="listing-web-apply"]');
    expect(apply).not.toBeNull();
    expect(apply!.textContent).toBe("Apply long term");
    expect(stickyBar().querySelector('[data-attr="listing-web-apply"]')!.textContent).toBe("Apply long term");
  });

  it("says Sign lease on both the price card and the sticky bar for a lease-first listing", () => {
    render(
      <ListingDetailSections
        property={property({ signingOrder: "lease_first", leaseSigningFeeCents: 0 })}
        rich={rich()}
      />,
    );
    expect(priceCard().querySelector('[data-attr="listing-web-apply"]')!.textContent).toBe("Sign lease long term");
    expect(stickyBar().querySelector('[data-attr="listing-web-apply"]')!.textContent).toBe("Sign lease long term");
  });

  it("swaps Application fee for Lease fee when lease-first and no fee is charged up front", () => {
    render(
      <ListingDetailSections
        property={property({ signingOrder: "lease_first", leaseSigningFeeCents: 10000 })}
        rich={rich({ pricingBreakdown: [{ label: "Security deposit", value: "$500" }] })}
      />,
    );
    const card = priceCard();
    expect(card.textContent).not.toContain("Application fee");
    const dueAtSigning = card.querySelector('[data-attr="listing-price-due-at-signing"]');
    expect(dueAtSigning).not.toBeNull();
    expect(dueAtSigning!.textContent).toContain("Lease fee");
    expect(dueAtSigning!.textContent).toContain("$100");
    // The unrelated deposit row is untouched.
    expect(card.textContent).toContain("Security deposit");
  });

  it("replaces the Application fee row with the Lease fee row for a lease-first listing (studio spec)", () => {
    render(
      <ListingDetailSections
        property={property({ signingOrder: "lease_first", leaseSigningFeeCents: 10000 })}
        rich={rich({ pricingBreakdown: [{ label: "Application fee", value: "$45" }] })}
      />,
    );
    const card = priceCard();
    expect(card.textContent).not.toContain("Application fee");
    expect(card.querySelector('[data-attr="listing-price-due-at-signing"]')!.textContent).toContain("$100");
    expect(card.querySelector('[data-attr="listing-web-apply"]')!.textContent).toBe("Sign lease long term");
  });

  it("reads None on the Lease fee row when the lease-signing fee is unset (0)", () => {
    render(
      <ListingDetailSections
        property={property({ signingOrder: "lease_first" })}
        rich={rich()}
      />,
    );
    const dueAtSigning = priceCard().querySelector('[data-attr="listing-price-due-at-signing"]');
    expect(dueAtSigning).not.toBeNull();
    expect(dueAtSigning!.textContent).toContain("None");
  });

  it("offers Apply short term only when the listing offers short stays, never a separate booking link", () => {
    render(<ListingDetailSections property={property()} rich={rich()} />);
    expect(priceCard().querySelector('[data-attr="listing-web-apply-short"]')).toBeNull();
    expect(priceCard().querySelector('a[href*="/rent/stay"]')).toBeNull();
    cleanup();

    const offering = property({
      id: "prop-short-stays",
      adminPublishLive: true,
      listingSubmission: { v: 1, shortTermRentalsAllowed: true, shortTermDailyCost: "85" },
    } as unknown as Partial<MockProperty>);
    cachePublicExtraListings([offering], { silent: true });
    render(<ListingDetailSections property={offering} rich={rich()} />);
    const card = priceCard();
    expect(card.querySelector('[data-attr="listing-web-apply"]')!.textContent).toBe("Apply long term");
    const short = card.querySelector('[data-attr="listing-web-apply-short"]') as HTMLAnchorElement | null;
    expect(short).not.toBeNull();
    expect(short!.textContent).toBe("Apply short term");
    expect(short!.getAttribute("href")).toContain("rentalType=short_term");
    expect(card.textContent).not.toContain("Book a short stay");
    expect(stickyBar().querySelector('[data-attr="listing-web-apply-short"]')!.textContent).toBe("Apply short term");
  });
});
