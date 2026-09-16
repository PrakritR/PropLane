// @vitest-environment jsdom
/**
 * The phone's sticky action bar (captain, Sep 15 2026): the price and rooms
 * line get a full row of their own, and the manager's two doors — the work
 * number and the work email — ride on that row as pills, so a renter on a
 * phone sees every way to reach the manager without scrolling back up.
 * A listing without a door prints no pill for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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

const WORK_NUMBER = "+12064420188";
const WORK_EMAIL = "leasing@mail.proplane.space";

function property(doors: { phone?: string | null; email?: string | null }): MockProperty {
  return {
    id: "prop-1",
    title: "5257 Brooklyn Avenue Northeast",
    address: "5257 Brooklyn Avenue Northeast, Seattle, WA 98105",
    neighborhood: "University District",
    contactSmsPhone: doors.phone ?? null,
    contactWorkEmail: doors.email ?? null,
  } as unknown as MockProperty;
}

const rich: ListingRichContent = {
  heroTagline: "",
  heroHousePhotoUrls: [],
  priceRangeLabel: "From $1,050/mo",
  startingRentLabel: "$1,050/mo",
  pricingBreakdown: [],
  floorPlans: [
    {
      name: "2nd floor",
      rooms: Array.from({ length: 9 }, (_, i) => ({
        id: `room-${i + 1}`,
        name: `Room ${i + 1}`,
        price: "$1,050/mo",
        availability: "Available now",
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

function bar() {
  const el = document.querySelector('[data-attr="listing-sticky-bar"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe("listing sticky bar", () => {
  it("prints the price, the rooms line and both actions", () => {
    render(<ListingDetailSections property={property({})} rich={rich} />);
    const el = bar();
    expect(el.textContent).toContain("$1,050/mo");
    expect(el.textContent).toContain("9 rooms · 9 available");
    expect(el.querySelector('[data-attr="listing-web-apply"]')).not.toBeNull();
    expect(el.querySelector('[data-attr="listing-web-tour"]')).not.toBeNull();
    // The price and rooms line share a row with the doors, the actions sit under them.
    const priceRow = el.firstElementChild as HTMLElement;
    expect(priceRow.textContent).toContain("$1,050/mo");
    expect(priceRow.querySelector('[data-attr="listing-web-tour"]')).toBeNull();
  });

  it("carries the work number and the work email as tappable pills when the listing has them", () => {
    render(<ListingDetailSections property={property({ phone: WORK_NUMBER, email: WORK_EMAIL })} rich={rich} />);
    const el = bar();
    const text = el.querySelector('[data-attr="listing-sticky-text"]') as HTMLAnchorElement | null;
    const email = el.querySelector('[data-attr="listing-sticky-email"]') as HTMLAnchorElement | null;
    expect(text).not.toBeNull();
    expect(text!.getAttribute("href")?.startsWith("sms:")).toBe(true);
    expect(text!.textContent).toMatch(/\(206\)/);
    expect(email).not.toBeNull();
    expect(email!.getAttribute("href")?.startsWith("mailto:")).toBe(true);
    expect(email!.getAttribute("href")).toContain(WORK_EMAIL);
  });

  it("prints no door the listing does not have", () => {
    render(<ListingDetailSections property={property({ email: WORK_EMAIL })} rich={rich} />);
    const el = bar();
    expect(el.querySelector('[data-attr="listing-sticky-text"]')).toBeNull();
    expect(el.querySelector('[data-attr="listing-sticky-email"]')).not.toBeNull();

    cleanup();
    render(<ListingDetailSections property={property({})} rich={rich} />);
    expect(bar().querySelector('[data-attr="listing-sticky-contact"]')).toBeNull();
  });
});
