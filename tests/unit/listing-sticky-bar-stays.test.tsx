// @vitest-environment jsdom
/**
 * The listing's phone action bar: one button per stay the listing offers — both stays reads Long
 * term, Short term, Tour, each opening its own application, and one stay reads Apply — with the
 * assistant floating above the bar instead of sharing its row (captain, 2026-10-06).
 */
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

const labels = () =>
  [...bar().querySelectorAll('[data-attr="listing-sticky-actions"] a')].map((a) => a.querySelector("[aria-hidden]")?.textContent ?? a.textContent);

describe("manager preview phone bar with both stays", () => {
  it("shows one Book and Tour, whatever stays the listing offers", () => {
    render(<ListingDetailSections property={property} rich={rich} portalEmbedded managerPreviewChrome hidePortalSubnav />);
    expect(labels()).toEqual(["Apply", "Tour"]);
    expect(bar().querySelector('[data-attr="listing-web-apply-short"]')).toBeNull();
    // A guest's Apply opens the public application with no account first (captain, Nov 14).
    expect(href('[data-attr="listing-web-apply"]')).toMatch(/^\/rent\/apply\?/);
    expect(href('[data-attr="listing-web-apply"]')).not.toContain("/auth/create-account");
    expect(bar().querySelector('[data-attr="listing-web-apply"]')?.textContent).toBe("Apply");
  });

  it("never draws two buttons to the same application", () => {
    render(<ListingDetailSections property={property} rich={rich} portalEmbedded managerPreviewChrome hidePortalSubnav />);
    const hrefs = [...bar().querySelectorAll<HTMLAnchorElement>('[data-attr="listing-sticky-actions"] a')].map((a) => a.getAttribute("href"));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("keeps one row", () => {
    stays.short = false;
    render(<ListingDetailSections property={property} rich={rich} portalEmbedded managerPreviewChrome hidePortalSubnav />);
    expect(labels()).toEqual(["Apply", "Tour"]);
    expect(bar().querySelector('[data-attr="listing-sticky-actions"]')?.parentElement?.className).not.toContain("flex-col");
  });
});

describe("the assistant floats above the bar", () => {
  // Oracle: AGENTS.md § AI Agent & Tool Layer - "One assistant surface: the side panel (desktop) / full-screen
  // sheet (phone), opened from the top bar; no floating button or pop-up". With no bubble there is nothing beside
  // the buttons to make room for and nothing to lift, so neither bar draws a FAB nor publishes its own height.
  // Plausible wrong behaviour this rejects: a floating assistant button back in the bar, or the bar reserving
  // space for one by setting the lift variable.
  it("neither bar draws a floating assistant nor publishes a height for one to be lifted by", () => {
    for (const props of [
      { portalEmbedded: true, managerPreviewChrome: true, hidePortalSubnav: true },
      {},
    ]) {
      cleanup();
      render(<ListingDetailSections property={property} rich={rich} {...props} />);
      expect(bar()).toBeTruthy();
      expect(document.querySelector(".axis-assistant-fab")).toBeNull();
      expect(document.querySelector('[data-attr="axis-assistant-fab"]')).toBeNull();
      expect(bar().style.getPropertyValue("--listing-sticky-bar-h")).toBe("");
      const lifted = [...document.querySelectorAll("[style]")].filter((el) =>
        (el.getAttribute("style") ?? "").includes("--listing-sticky-bar-h"),
      );
      expect(lifted).toEqual([]);
    }
  });

  it("the non-dock bar keeps its two rows", () => {
    render(<ListingDetailSections property={property} rich={rich} />);
    expect(bar().hasAttribute("data-slim")).toBe(false);
    expect(bar().textContent).toContain("Apply");
    expect(bar().textContent).toContain("Tour");
    expect(bar().textContent).not.toContain("Apply long term");
  });
});
