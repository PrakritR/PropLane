// @vitest-environment jsdom
/**
 * "Open now" is the ONE availability count, and every live listing surface prints it: the title line,
 * the key-facts rooms tile, the Rooms section aside, the room rows and the phone sticky bar. A room
 * that frees later reads "Opens <date>" and is never counted; nothing open claims no availability.
 *
 * Set `EVIDENCE_DIR` to also write the rendered page HTML (reviewer evidence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { buildListingShareSummary } from "@/lib/listing-share-summary";
import { buildLeadInviteEmailHtml } from "@/lib/lead-invite-email";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import type { ListingRichContent } from "@/data/listing-rich-content";

vi.mock("@/components/marketing/listing-location-block", () => ({
  ListingLocationBlock: () => null,
}));
const occupancy = vi.hoisted(() => ({
  state: {
    rooms: [] as { roomChoice: string; spans: { start: string; end: string | null; count: number }[] }[],
    loading: false,
    failed: false,
  },
}));
vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => occupancy.state,
  useListingsPublicOccupancy: () => occupancy.state,
}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));
vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => null,
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

const HOUSE = "prop-open-now";
const TODAY = "2026-11-17";
const ROOM_COUNT = 9;

function property(): MockProperty {
  const submission = createDefaultListingSubmission();
  submission.rooms = Array.from({ length: ROOM_COUNT }, (_, i) => ({
    ...submission.rooms[0]!,
    id: `room-${i + 1}`,
    name: `Room ${i + 1}`,
    monthlyRent: 1050 + i * 25,
    occupancyCapacity: 1,
  }));
  return {
    id: HOUSE,
    title: "5257 Brooklyn Avenue Northeast",
    tagline: "Nine private rooms a block from campus.",
    address: "5257 Brooklyn Avenue Northeast, Seattle, WA 98105",
    zip: "98105",
    neighborhood: "University District",
    beds: ROOM_COUNT,
    baths: 3,
    rentLabel: "$1,050/mo",
    available: "",
    petFriendly: true,
    buildingId: "b-1",
    buildingName: "Brooklyn House",
    unitLabel: "",
    adminPublishLive: true,
    listingSubmission: submission,
  } as unknown as MockProperty;
}

const rich: ListingRichContent = {
  heroTagline: "Nine private rooms a block from campus.",
  heroHousePhotoUrls: [],
  priceRangeLabel: "From $1,050/mo",
  startingRentLabel: "$1,050/mo",
  pricingBreakdown: [],
  floorPlans: [
    {
      floorLabel: "2nd floor",
      name: "2nd floor",
      fromPrice: "$1,050/mo",
      roomCount: ROOM_COUNT,
      rooms: Array.from({ length: ROOM_COUNT }, (_, i) => ({
        id: `room-${i + 1}`,
        name: `Room ${i + 1}`,
        detail: "Private room",
        price: `$${1050 + i * 25}/mo`,
        availability: "Available now",
        occupancyCapacity: 1,
        modal: { photoUrls: [], includedTags: [], setupLine: "", tourEyebrow: "", tourTitle: "", tourSubtitle: "" },
      })),
    },
  ] as unknown as ListingRichContent["floorPlans"],
  bathrooms: [],
  sharedSpaces: [],
  leaseBasics: [],
  amenities: [],
  bundlesText: "",
  bundleCards: [],
  quickFacts: [
    { label: "Type", value: "Shared housing" },
    { label: "Pets", value: "Ask manager" },
  ],
};

/** Rooms 1-2 open today; room 3 frees Dec 1; rooms 4-9 held with no end date. */
const TWO_OPEN = Array.from({ length: ROOM_COUNT }, (_, i) => i + 1)
  .filter((n) => n >= 3)
  .map((n) => ({
    roomChoice: `${HOUSE}::room-${n}`,
    spans: [{ start: "2026-01-01", end: n === 3 ? "2026-11-30" : null, count: 1 }],
  }));

/** Every room held; room 3 still frees Dec 1, so the page says when instead of "0 open now". */
const NONE_OPEN = Array.from({ length: ROOM_COUNT }, (_, i) => i + 1).map((n) => ({
  roomChoice: `${HOUSE}::room-${n}`,
  spans: [{ start: "2026-01-01", end: n === 3 ? "2026-11-30" : null, count: 1 }],
}));

function writeEvidence(name: string, html: string) {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, html);
}

beforeEach(() => {
  // Pinned day: the scenario's dates ("Opens Dec 1") must mean the same thing next year.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T20:00:00.000Z`));
  occupancy.state = { rooms: [], loading: false, failed: false };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("every live listing surface prints one open-now count", () => {
  it("two rooms open today: title line, rooms tile, Rooms aside, room rows and sticky bar agree", () => {
    occupancy.state = { rooms: TWO_OPEN, loading: false, failed: false };
    const { container } = render(<ListingDetailSections property={property()} rich={rich} phoneDock />);
    const text = container.textContent ?? "";

    expect(text).toContain("2 of 9 rooms open now");
    expect(text).toContain("9 rooms · 2 open now");
    // The key-facts rooms tile: "9 rooms" over "2 open now".
    expect(text).toContain("2 open now");
    // Two rows read "Open now"; the room freeing Dec 1 reads "Opens Dec 1"; nothing says "available".
    const rowStatuses = [...container.querySelectorAll(".ps-row.ps-room")].map((row) => row.textContent ?? "");
    expect(rowStatuses.filter((row) => row.includes("Open now"))).toHaveLength(2);
    expect(rowStatuses.filter((row) => row.includes("Opens Dec 1"))).toHaveLength(1);
    expect(text).not.toMatch(/\d+ available/i);
    expect(text.toLowerCase()).not.toContain("available now");

    writeEvidence(
      "listing-open-now-two-open.html",
      `<!doctype html><html><head><meta charset="utf-8"><title>Listing · 2 of 9 rooms open now</title></head><body>${container.innerHTML}</body></html>`,
    );
  });

  it("nothing open: the page says when the first room frees up and claims no availability", () => {
    occupancy.state = { rooms: NONE_OPEN, loading: false, failed: false };
    const { container } = render(<ListingDetailSections property={property()} rich={rich} phoneDock />);
    const text = container.textContent ?? "";
    expect(text).toContain("Next opening Dec 1");
    expect(text).not.toContain("open now");
    expect(text.toLowerCase()).not.toContain("available now");

    writeEvidence(
      "listing-open-now-none-open.html",
      `<!doctype html><html><head><meta charset="utf-8"><title>Listing · nothing open today</title></head><body>${container.innerHTML}</body></html>`,
    );
  });

  it("while occupancy loads it claims nothing at all", () => {
    occupancy.state = { rooms: [], loading: true, failed: false };
    const { container } = render(<ListingDetailSections property={property()} rich={rich} phoneDock />);
    const text = container.textContent ?? "";
    expect(text).toContain("9 rooms");
    expect(text).not.toContain("open now");
    expect(text.toLowerCase()).not.toContain("available now");
  });
});

describe("the shared listing email says what the page says", () => {
  it("prints '2 of 9 rooms open now' from the same count, and no claim without a read", () => {
    const summary = buildListingShareSummary(property(), { openNow: 2 });
    expect(summary.detailLines).toContain("2 of 9 rooms open now");
    expect(buildListingShareSummary(property()).detailLines).toContain("9 rooms");

    const html = buildLeadInviteEmailHtml({
      kind: "listing",
      prospectName: "Alex Kim",
      propertyTitle: "5257 Brooklyn Avenue Northeast",
      linkUrl: `https://proplane.space/rent/listings/${HOUSE}`,
      listingPageUrl: `https://proplane.space/rent/listings/${HOUSE}`,
      tourUrl: `https://proplane.space/rent/listings/${HOUSE}/tour`,
      listingSummary: summary,
      managerNote: "Happy to show you around this week.",
    } as Parameters<typeof buildLeadInviteEmailHtml>[0]);
    expect(html).toContain("2 of 9 rooms open now");
    expect(html).not.toMatch(/9 rooms available/);
    writeEvidence("share-listing-email-open-now.html", html);
  });
});


/* ── Month-to-month: the public listing ends an open-ended residency through `leaseBlockEnd`, so a
      stale past leaseEnd never reads the room free. Spans come from the real server loader. ── */
async function spansFromServer(leaseTerm: string) {
  const { loadPublicRoomOccupancy } = await import("@/lib/public-room-occupancy.server");
  const submission = createDefaultListingSubmission();
  submission.rooms = Array.from({ length: ROOM_COUNT }, (_, i) => ({
    ...submission.rooms[0]!,
    id: `room-${i + 1}`,
    name: `Room ${i + 1}`,
    occupancyCapacity: 1,
  }));
  const application = {
    id: "AXIS-MTM1",
    manager_user_id: "owner-1",
    assigned: HOUSE,
    choice: `${HOUSE}::room-1`,
    lease_start: "2025-01-01",
    lease_end: "2025-12-31", // stale: the resident never left
    lease_term: leaseTerm,
  };
  const db = {
    from(table: string) {
      const query = {
        select() { return this; },
        in() { return this; },
        eq() { return this; },
        or() { return this; },
        order() { return this; },
        range(start: number) {
          const rows = table === "manager_application_records" ? [application] : [];
          return Promise.resolve({ data: rows.slice(start), error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data =
            table === "manager_property_records"
              ? [{ id: HOUSE, manager_user_id: "owner-1", property_data: { listingSubmission: submission } }]
              : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
  return loadPublicRoomOccupancy(db, [{ id: HOUSE, listingSubmission: submission } as never], "owner-1");
}

describe("a month-to-month residency still holds its room on the public listing", () => {
  it("a stale past leaseEnd does not publish the room as open; a fixed term that really ended does", async () => {
    const monthToMonth = await spansFromServer("Month-to-Month");
    occupancy.state = { rooms: monthToMonth as never, loading: false, failed: false };
    const live = render(<ListingDetailSections property={property()} rich={rich} phoneDock />);
    const heldText = live.container.textContent ?? "";
    expect(heldText).toContain("8 of 9 rooms open now");
    expect([...live.container.querySelectorAll(".ps-row.ps-room")][0]!.textContent).not.toContain("Open now");
    writeEvidence(
      "listing-month-to-month-held.html",
      `<!doctype html><html><head><meta charset="utf-8"><title>Listing · month-to-month room still held</title></head><body>${live.container.innerHTML}</body></html>`,
    );
    cleanup();

    const fixedTerm = await spansFromServer("12 months");
    occupancy.state = { rooms: fixedTerm as never, loading: false, failed: false };
    const freed = render(<ListingDetailSections property={property()} rich={rich} phoneDock />);
    expect(freed.container.textContent ?? "").toContain("9 rooms · 9 open now");
    writeEvidence(
      "listing-fixed-term-ended.html",
      `<!doctype html><html><head><meta charset="utf-8"><title>Listing · fixed term ended, room open</title></head><body>${freed.container.innerHTML}</body></html>`,
    );
  });
});
