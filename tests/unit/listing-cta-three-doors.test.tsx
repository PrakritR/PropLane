// @vitest-environment jsdom
/**
 * The listing price card offers three separate, differently-labelled doors:
 * Schedule tour, Apply, and — only when the manager has a real work number — Text.
 *
 * It used to SWAP instead of add: a work number replaced "Schedule a tour" with
 * "Text to tour" and "Apply online" with "Text to apply", so a prospect on a
 * desktop browser was offered two SMS links and could reach the booking form only
 * through a footnote ("No texting on this device?"). Booking and applying now come
 * first always, and texting is additive.
 *
 * The red messaging-setup banner is MANAGER-ONLY. It must never appear on the
 * public listing page — that would put the owner's setup chrome in front of a
 * prospect.
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

/* Not a 555 exchange: `usableCtaSmsPhone` rejects fictional numbers on purpose. */
const WORK_NUMBER = "+12064420188";

function property(contactSmsPhone: string | null): MockProperty {
  return {
    id: "prop-1",
    title: "4709A 8th Ave NE",
    address: "8th Avenue Northeast, 98015",
    neighborhood: "Capitol Hill",
    contactSmsPhone,
  } as unknown as MockProperty;
}

const rich: ListingRichContent = {
  heroTagline: "",
  heroHousePhotoUrls: [],
  priceRangeLabel: "From $50.00/night",
  startingRentLabel: "$50.00/night",
  pricingBreakdown: [],
  floorPlans: [],
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

describe("listing price card CTAs", () => {
  it("offers Schedule tour and Apply even when the manager can be texted", () => {
    render(<ListingDetailSections property={property(WORK_NUMBER)} rich={rich} />);
    expect(screen.getAllByText("Schedule tour").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Apply").length).toBeGreaterThan(0);
    expect(screen.queryByText("Text to tour")).toBeNull();
    expect(screen.queryByText("Text to apply")).toBeNull();
    expect(screen.queryByText(/No texting on this device/)).toBeNull();
  });

  it("adds a Text button only when a real work number is set", () => {
    render(<ListingDetailSections property={property(WORK_NUMBER)} rich={rich} />);
    const text = screen.getAllByText("Text")[0] as HTMLAnchorElement;
    expect(text.getAttribute("href")?.startsWith("sms:")).toBe(true);
  });

  it("shows no Text button when the manager has no work number", () => {
    render(<ListingDetailSections property={property(null)} rich={rich} />);
    expect(screen.queryByText("Text")).toBeNull();
    expect(screen.getAllByText("Schedule tour").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Apply").length).toBeGreaterThan(0);
  });
});

describe("messaging-setup banner", () => {
  it("prompts the manager to set up messaging when the listing has no work number", () => {
    render(
      <ListingDetailSections property={property(null)} rich={rich} managerPreviewChrome />,
    );
    const link = screen.getByText("Set up messaging") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/portal/profile?tab=messaging");
  });

  it("does not prompt once a work number is set", () => {
    render(
      <ListingDetailSections property={property(WORK_NUMBER)} rich={rich} managerPreviewChrome />,
    );
    expect(screen.queryByText("Set up messaging")).toBeNull();
  });

  it("never reaches a prospect on the public listing page", () => {
    render(<ListingDetailSections property={property(null)} rich={rich} />);
    expect(screen.queryByText("Set up messaging")).toBeNull();
    expect(screen.queryByText(/Set up messaging so renters/)).toBeNull();
  });
});
