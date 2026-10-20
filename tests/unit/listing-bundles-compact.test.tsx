// @vitest-environment jsdom
/**
 * "Bundles & leasing" on the public listing: each card is a label, one glyph fact line and a figure,
 * and the lease lengths row is just the values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { listingRichFromManagerSubmission } from "@/data/listing-rich-from-submission";
import type { MockProperty } from "@/data/types";
import {
  createDefaultListingSubmission,
  formatLeaseTermsBodyFromAllowed,
  leaseLengthsDisplayText,
} from "@/lib/manager-listing-submission";

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

function property(sub: ReturnType<typeof createDefaultListingSubmission>): MockProperty {
  return {
    id: "mgr-bundles-compact",
    title: "Magnolia House",
    tagline: "Shared house",
    address: "1420 Magnolia Ave, Seattle, WA",
    zip: "98122",
    neighborhood: "Capitol Hill",
    beds: 3,
    baths: 2,
    rentLabel: "$1,000–$1,200 / mo",
    available: "Now",
    petFriendly: true,
    buildingId: "b1",
    buildingName: "Magnolia House",
    unitLabel: "3 rooms",
    adminPublishLive: true,
    listingSubmission: sub,
  } as MockProperty;
}

function submissionWithRents(rents: number[]) {
  const sub = createDefaultListingSubmission();
  const base = sub.rooms[0]!;
  sub.rooms = rents.map((monthlyRent, i) => ({ ...base, id: `room-${i + 1}`, name: `Room ${i + 1}`, monthlyRent }));
  sub.bundles = [];
  return sub;
}

describe("compact bundle card", () => {
  it("is a label, a rooms-and-price fact line, and 'from <two cheapest>/mo'", () => {
    const sub = submissionWithRents([1000, 1000, 1200]);
    const rich = listingRichFromManagerSubmission(property(sub), sub);
    const card = rich.bundleCards[0]!;
    expect(card.label).toBe("Two or more rooms");
    expect(card.price).toBe("from $2,000/mo");
    expect(card.facts).toEqual([
      { icon: "rooms", text: "3 rooms" },
      { icon: "price", text: "$1,000–$1,200 each" },
    ]);
  });

  it("states one price when every room costs the same", () => {
    const sub = submissionWithRents([1000, 1000, 1000]);
    const card = listingRichFromManagerSubmission(property(sub), sub).bundleCards[0]!;
    expect(card.facts?.[1]).toEqual({ icon: "price", text: "$1,000 each" });
  });

  it("keeps a custom bundle's own price as the figure and derives its facts from the rooms it includes", () => {
    const sub = submissionWithRents([1000, 1100, 1200]);
    sub.bundles = [
      {
        id: "b1",
        label: "Back two",
        price: "$2,100/mo",
        strikethrough: "",
        promo: "",
        roomsLine: "",
        includedRoomIds: ["room-2", "room-3"],
      },
    ];
    const card = listingRichFromManagerSubmission(property(sub), sub).bundleCards[0]!;
    expect(card.price).toBe("$2,100/mo");
    expect(card.facts).toEqual([
      { icon: "rooms", text: "2 rooms" },
      { icon: "price", text: "$1,100–$1,200 each" },
    ]);
  });

  it("renders only the label, the fact line and the figure on the listing page", () => {
    const sub = submissionWithRents([1000, 1000, 1200]);
    const property_ = property(sub);
    const rich = listingRichFromManagerSubmission(property_, sub);
    render(<ListingDetailSections property={property_} rich={rich} />);
    const section = document.getElementById("bundles");
    expect(section).not.toBeNull();
    const text = section!.textContent ?? "";
    expect(text).toContain("Two or more rooms");
    expect(text).toContain("3 rooms");
    expect(text).toContain("$1,000–$1,200 each");
    expect(text).toContain("from $2,000/mo");
    expect(text).not.toContain("Combine 2+ bedrooms");
    expect(text).not.toContain("rent 2 or more together");
    expect(text).not.toMatch(/utilities/i);
    expect(text).not.toContain("2-room start");
    expect(section!.querySelector(".ps-pack-lines")).toBeNull();
    expect(section!.querySelectorAll('[data-attr="listing-bundle-facts"] svg').length).toBe(2);
  });
});

describe("lease lengths row", () => {
  it("strips the stored label and closing period on read", () => {
    expect(leaseLengthsDisplayText("Available lease lengths: 3 months, 6 months, 12 months.")).toBe(
      "3 months, 6 months, 12 months",
    );
    expect(leaseLengthsDisplayText("  available lease lengths:12-Month.  ")).toBe("12-Month");
  });

  it("leaves manager-written prose untouched", () => {
    expect(leaseLengthsDisplayText("Flexible. Ask about 9 months.")).toBe("Flexible. Ask about 9 months.");
    expect(leaseLengthsDisplayText("")).toBe("");
  });

  it("keeps the stored body labelled (the lease document reads it) and the listing shows just the values", () => {
    const stored = formatLeaseTermsBodyFromAllowed(["12-Month", "Month-to-Month"]);
    expect(stored).toBe("Available lease lengths: 12-Month, Month-to-Month.");
    expect(leaseLengthsDisplayText(stored)).toBe("12-Month, Month-to-Month");
    expect(formatLeaseTermsBodyFromAllowed([])).toBe("");
  });

  it("reaches the listing page as just the values for a row stored with the label", () => {
    const sub = submissionWithRents([1000, 1200]);
    sub.leaseTermsBody = "Available lease lengths: 3 months, 6 months, 12 months.";
    const rich = listingRichFromManagerSubmission(property(sub), sub);
    expect(rich.bundlesText).toBe("3 months, 6 months, 12 months");
  });
});
