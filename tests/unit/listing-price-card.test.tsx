// @vitest-environment jsdom
/**
 * The public listing's price card: a price line that is never a dash or $0, and exactly two actions,
 * Tour and Book (captain, Nov 12: no Monthly | Short stay control, no move-in or room pickers). Book
 * opens the quick sheet for a signed-in resident with saved answers (Continue application when those
 * answers do not cover the listing) and is the plain apply door for everyone else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { resetQuickApplyReadiness } from "@/hooks/use-quick-apply-eligibility";
import { listingMonthlyPriceLine } from "@/lib/listing-price-line";
import { resetSharedGets } from "@/lib/shared-get-cache";
import type { ListingRichContent } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";

const session = vi.hoisted(() => ({
  state: { ready: true, userId: null as string | null, hasResidentRole: false, name: "", email: "", phone: "" },
}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({ useProspectContactAutofill: () => session.state }));
vi.mock("@/hooks/use-listing-public-occupancy", () => ({ useListingPublicOccupancy: () => ({ loading: false, rooms: [] }) }));
vi.mock("@/components/marketing/listing-location-block", () => ({ ListingLocationBlock: () => null }));
vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => null,
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

const WORK_NUMBER = "+18146793694";

function property(overrides: Record<string, unknown> = {}): MockProperty {
  return {
    id: "prop-1",
    title: "5257 Brooklyn Avenue Northeast",
    address: "5257 Brooklyn Avenue Northeast, Seattle, WA 98105",
    neighborhood: "University District",
    contactSmsPhone: WORK_NUMBER,
    listingSubmission: { v: 1, rooms: [{ id: "r1", name: "Room 1" }] },
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

const withShortStay = () =>
  property({ listingSubmission: { v: 1, shortTermRentalsAllowed: true, shortTermDailyCost: "55", rooms: [{ id: "r1", name: "Room 1" }] } });

const card = () => document.querySelector('[data-attr="listing-price-card"]') as HTMLElement;

function stubFetch(handlers: { profile: unknown; dryRun: unknown; dryRunStatus?: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("resident-application-autofill")) {
        // The public card asks the existence-only form of the route: a boolean, never the saved answers.
        expect(String(url)).toContain("exists=1");
        return new Response(JSON.stringify({ hasProfile: Boolean(handlers.profile) }), { status: 200 });
      }
      if (String(url).includes("quick-apply") && JSON.parse(String(init?.body ?? "{}")).dryRun) {
        return new Response(JSON.stringify(handlers.dryRun), { status: handlers.dryRunStatus ?? 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
}

beforeEach(() => {
  session.state = { ready: true, userId: null, hasResidentRole: false, name: "", email: "", phone: "" };
  resetSharedGets();
  resetQuickApplyReadiness();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("price rows", () => {
  it("lists every price that exists, in order, and none that does not", () => {
    const sub = {
      v: 1,
      securityDeposit: "1000",
      shortTermRentalsAllowed: true,
      shortTermDailyCost: "55",
      rooms: [
        { id: "r1", name: "Room 1", securityDeposit: "" },
        { id: "r9", name: "Room 9", securityDeposit: "1500" },
      ],
    };
    render(
      <ListingDetailSections
        property={property({ listingSubmission: sub })}
        rich={rich({
          pricingBreakdown: [
            { label: "Application fee", value: "$45" },
            { label: "Nightly rate", value: "$55/night" },
            { label: "Parking", value: "$75/mo" },
          ],
        })}
      />,
    );
    // The rent is the page's price figure; the Costs section lists everything else, in order.
    const rows = Array.from(document.querySelectorAll('[data-attr="listing-price-rows"] > li')).map((r) => r.textContent);
    expect(card().querySelector('[data-attr="listing-price-rows"]')).toBeNull();
    expect(rows).toEqual([
      "Security deposit$1,000",
      "Deposit · Room 9$1,500",
      "Application fee$45",
      "Nightly rate$55/night",
      "First monthProrated by day",
      "Parking$75/mo",
    ]);
  });
});

describe("price line", () => {
  it("is the stated monthly rent, with no Base rent row", () => {
    render(<ListingDetailSections property={property()} rich={rich()} />);
    expect(card().querySelector('[data-attr="listing-price-line"]')!.textContent).toBe("$1,050 / mo");
    expect(card().textContent).not.toContain("Base rent");
  });

  it("falls back to the lowest room rent when the base rent is zero", () => {
    const zero = rich({
      startingRentLabel: "",
      priceRangeLabel: "Base rent $0",
      floorPlans: [
        {
          name: "Floor 1",
          rooms: [
            { id: "r1", name: "Room 1", priceHeadlineAmount: 1200, availability: "Available now", modal: { photoUrls: [] } },
            { id: "r2", name: "Room 2", priceHeadlineAmount: 1050, availability: "Available now", modal: { photoUrls: [] } },
          ],
        },
      ] as unknown as ListingRichContent["floorPlans"],
    });
    expect(listingMonthlyPriceLine(zero)!.label).toBe("from $1,050 / mo");
    render(<ListingDetailSections property={property()} rich={zero} />);
    expect(card().querySelector('[data-attr="listing-price-line"]')!.textContent).toBe("from $1,050 / mo");
    expect(card().textContent).not.toContain("$0");
  });

  it("says 'from' when the rooms are not all one price, even with a stated starting rent", () => {
    const roomsFloor = (lo: number, hi: number) =>
      [
        {
          name: "Floor 1",
          rooms: [
            { id: "r1", name: "Room 1", priceHeadlineAmount: hi, availability: "Available now", modal: { photoUrls: [] } },
            { id: "r2", name: "Room 2", priceHeadlineAmount: lo, availability: "Available now", modal: { photoUrls: [] } },
          ],
        },
      ] as unknown as ListingRichContent["floorPlans"];
    // `startingRentLabel` IS the cheapest room's rent for a submission-derived listing, so its presence
    // can never mean "one stated rent".
    const spread = rich({
      startingRentLabel: "$1,050/mo",
      priceRangeLabel: "base rent $1,050–$1,800/mo",
      floorPlans: roomsFloor(1050, 1800),
    });
    expect(listingMonthlyPriceLine(spread)).toMatchObject({ label: "from $1,050 / mo", amount: 1050, from: true });
    const flat = rich({
      startingRentLabel: "$1,050/mo",
      priceRangeLabel: "base rent $1,050/mo",
      floorPlans: roomsFloor(1050, 1050),
    });
    expect(listingMonthlyPriceLine(flat)).toMatchObject({ label: "$1,050 / mo", from: false });
  });

  it("prints no price line at all when nothing prices the listing", () => {
    const none = rich({ startingRentLabel: "", priceRangeLabel: "" });
    expect(listingMonthlyPriceLine(none)).toBeNull();
    render(<ListingDetailSections property={property()} rich={none} />);
    expect(card().querySelector('[data-attr="listing-price-line"]')).toBeNull();
    expect(card().textContent).not.toContain("—");
  });
});

describe("actions", () => {
  it("is the price, then Tour and Book: no stay-type control, no pickers, no short-stay block, even with a nightly rate", () => {
    for (const p of [property(), withShortStay()]) {
      render(<ListingDetailSections property={p} rich={rich()} />);
      expect(card().querySelector('[data-attr="listing-price-line"]')!.textContent).toBe("$1,050 / mo");
      expect(card().querySelector('[data-attr="listing-stay-segments"]')).toBeNull();
      expect(card().querySelector('[data-attr="listing-monthly-fields"]')).toBeNull();
      expect(card().querySelector('[data-attr="listing-move-in"]')).toBeNull();
      expect(card().querySelector('[data-attr="listing-room-select"]')).toBeNull();
      expect(card().querySelector('[data-attr="listing-book-short-term"]')).toBeNull();
      expect(document.querySelector('[data-attr="short-stay-block"], [data-attr="short-stay-request"]')).toBeNull();
      expect(document.body.textContent).not.toMatch(/Short stay|Book short term|Request to book|\/ night\b/);
      cleanup();
    }
  });

  it("has exactly two actions, Tour and Book, no Text us and no Email door", () => {
    render(<ListingDetailSections property={property()} rich={rich()} />);
    expect(card().querySelector('[data-attr="listing-web-apply"]')!.textContent).toBe("Book");
    expect(card().querySelector('[data-attr="listing-web-tour"]')!.textContent).toBe("Tour");
    expect(card().querySelectorAll(".ps-ld-acts a, .ps-ld-acts button")).toHaveLength(2);
    expect(card().querySelector('[data-attr="listing-text-tour"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Email the manager");
    expect(document.body.textContent).not.toContain("Apply long term");
    expect(document.body.textContent).not.toContain("Apply short term");
    expect(document.body.textContent).not.toContain("Book a tour");
  });

  it("the phone's in-page block is gone: the dock carries the actions", () => {
    render(<ListingDetailSections property={property()} rich={rich()} phoneDock />);
    expect(document.querySelector('[data-attr="listing-phone-price-card"], [data-attr="listing-inline-card"]')).toBeNull();
    const dock = document.querySelector('[data-attr="listing-sticky-bar"]')!;
    expect([...dock.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Tour", "Book"]);
  });
});

describe("Quick book vs Book", () => {
  it("a signed-out visitor sees Book and never calls the saved-answers route", () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    render(<ListingDetailSections property={property()} rich={rich()} />);
    expect(card().querySelector('[data-attr="listing-quick-apply"]')).toBeNull();
    expect(card().querySelector('[data-attr="listing-web-apply"]')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a resident with no saved application keeps Book", async () => {
    session.state = { ready: true, userId: "u1", hasResidentRole: true, name: "Dana", email: "dana@example.com", phone: "" };
    stubFetch({ profile: null, dryRun: { ready: true } });
    render(<ListingDetailSections property={property()} rich={rich()} />);
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    expect(card().querySelector('[data-attr="listing-quick-apply"]')).toBeNull();
    expect(card().querySelector('[data-attr="listing-web-apply"]')!.textContent).toBe("Book");
  });

  it("a resident with saved answers sees Book (opening the quick sheet), and the same word in the sticky bar", async () => {
    session.state = { ready: true, userId: "u1", hasResidentRole: true, name: "Dana", email: "dana@example.com", phone: "" };
    stubFetch({ profile: { fullLegalName: "Dana Resident" }, dryRun: { ready: true } });
    render(<ListingDetailSections property={property()} rich={rich()} />);
    await waitFor(() => expect(card().querySelector('[data-attr="listing-quick-apply"]')).not.toBeNull());
    expect(card().querySelector('[data-attr="listing-quick-apply"]')!.textContent).toBe("Book");
    expect(document.querySelector('[data-attr="listing-sticky-bar"] [data-attr="listing-quick-apply"]')).not.toBeNull();
    expect(card().querySelector('[data-attr="listing-web-apply"]')).toBeNull();
  });

  it("reads Continue application, linking to the wizard, when the saved answers do not cover the listing", async () => {
    session.state = { ready: true, userId: "u1", hasResidentRole: true, name: "Dana", email: "dana@example.com", phone: "" };
    stubFetch({
      profile: { fullLegalName: "Dana Resident" },
      dryRun: { needsWizard: true, reason: "missing_answers", href: "/resident/applications/apply?propertyId=prop-1&prefill=1" },
    });
    render(<ListingDetailSections property={property()} rich={rich()} />);
    await waitFor(() => expect(card().querySelector('[data-attr="listing-continue-application"]')).not.toBeNull());
    const link = card().querySelector('[data-attr="listing-continue-application"]') as HTMLAnchorElement;
    expect(link.textContent).toBe("Continue application");
    expect(link.getAttribute("href")).toBe("/resident/applications/apply?propertyId=prop-1&prefill=1");
  });
});
