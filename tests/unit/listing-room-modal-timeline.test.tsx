// @vitest-environment jsdom
/**
 * The room modal: its Availability timeline draws from the same occupancy rows as its Status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ListingDetailModal } from "@/components/marketing/listing-detail-tables-client";
import type { ListingRoomRow } from "@/data/listing-rich-content";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

let occupancyRows: PublicRoomOccupancy[] = [];
let occupancyLoading = false;

vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({ rooms: occupancyRows, loading: occupancyLoading, failed: false }),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

afterEach(() => {
  cleanup();
  occupancyRows = [];
  occupancyLoading = false;
});

function roomRow(overrides: Partial<ListingRoomRow> = {}): ListingRoomRow {
  return {
    id: "room-1",
    name: "Room 1",
    detail: "Listed by manager",
    price: "$1150",
    pricePeriod: "month",
    priceHeadlineAmount: 1150,
    availability: "Available now",
    modal: {
      setupLine: "",
      bathroomShortLabel: "Shared bathroom",
      tourEyebrow: "Room tour",
      tourTitle: "Video tour",
      tourSubtitle: "",
      includedTags: [],
      photoCaptions: [],
      floorLine: "2nd floor",
    } as ListingRoomRow["modal"],
    ...overrides,
  };
}

function renderRoom(room: ListingRoomRow) {
  render(
    <ListingDetailModal
      state={{ kind: "room", room, floorLabel: "2nd floor" }}
      onClose={() => {}}
      listingPropertyId="mgr-test-alder"
    />,
  );
}

/** The day numbers the calendar grid draws red (the key's swatch carries no number). */
function redDays(): string[] {
  return Array.from(document.querySelectorAll("button, div, span"))
    .filter((n) => /\bbg-rose-100\b/.test(n.className?.toString() ?? "") && /^\d+$/.test(n.textContent ?? ""))
    .map((n) => n.textContent ?? "");
}

describe("room modal availability timeline", () => {
  it("drops the explanatory sentences and keeps the heading, key and calendar", () => {
    renderRoom(roomRow());
    expect(screen.getByText("Availability")).toBeTruthy();
    expect(screen.queryByText(/No blocked ranges/)).toBeNull();
    expect(screen.queryByText(/Green dates are open/)).toBeNull();
    expect(screen.getByLabelText("Calendar key")).toBeTruthy();
    expect(screen.getByLabelText("Next month")).toBeTruthy();
  });

  it("draws today red when the fetched rows say the room is taken, matching the Not available status", () => {
    occupancyRows = [{ roomChoice: "mgr-test-alder::room-1", spans: [{ start: "2020-01-01", end: null, count: 1 }] }];
    renderRoom(roomRow());
    expect(screen.getByText("Not available")).toBeTruthy();
    // Today is in the first month shown, so at least today is drawn red.
    expect(redDays().length).toBeGreaterThan(0);
  });

  it("draws a room closed by its own copy red from today even with no dated rows", () => {
    renderRoom(roomRow({ availability: "Leased" }));
    expect(screen.getByText("Not available")).toBeTruthy();
    // Today is in the first month shown, so at least today is drawn red.
    expect(redDays().length).toBeGreaterThan(0);
  });

  it("leaves an open room green", () => {
    renderRoom(roomRow());
    expect(screen.getByText("Available now")).toBeTruthy();
    expect(redDays()).toEqual([]);
  });
});


describe("room modal layout (popup standard)", () => {
  function richRoom() {
    return roomRow({
      modal: {
        setupLine: "",
        bathroomShortLabel: "Shared bathroom",
        bathroomAccessLines: ["Shared with Room 2"],
        tourEyebrow: "Room tour",
        tourTitle: "Video tour",
        tourSubtitle: "",
        includedTags: ["Desk", "Wardrobe", "Shared bath"],
        roomAmenityLabels: ["Wi-Fi"],
        roomNotes: "Bright corner room facing the garden.",
        furnishingDetail: "Bright corner room facing the garden.",
        floorLine: "2nd floor",
      } as ListingRoomRow["modal"],
      utilitiesEstimate: "$90/mo",
    });
  }

  it("heads the popup with the room name and the rent figure", () => {
    renderRoom(richRoom());
    const header = document.querySelector('[data-attr="listing-room-modal-header"]')!;
    expect(header.textContent).toContain("Room 1");
    expect(header.textContent).toContain("$1,150");
    expect(header.textContent).toContain("/mo");
  });

  it("lists floor, bathroom, utilities and status as flat label/value rows with no bordered box or pill", () => {
    renderRoom(richRoom());
    const facts = document.querySelector('[data-attr="listing-room-facts"]')!;
    const labels = Array.from(facts.querySelectorAll("dt")).map((n) => n.textContent);
    expect(labels).toEqual(["Floor", "Bathroom", "Utilities (est.)", "Status"]);
    expect(facts.textContent).toContain("2nd floor");
    expect(facts.textContent).toContain("Shared with Room 2");
    expect(facts.textContent).toContain("$90/mo");
    expect(facts.querySelector(".rounded-full.ring-1")).toBeNull();
    expect(facts.querySelector('[class*="rounded-xl"]')).toBeNull();
  });

  it("prints Included as one plain comma list and the description once", () => {
    renderRoom(richRoom());
    expect(document.querySelector('[data-attr="listing-room-included"]')!.textContent).toBe("Desk, Wardrobe, Wi-Fi");
    expect(document.querySelectorAll('[data-attr="listing-room-description"]')).toHaveLength(1);
    expect(screen.getAllByText("Bright corner room facing the garden.")).toHaveLength(1);
  });

  it("keeps the existing actions: Apply and Schedule tour, no phone number or text link", () => {
    renderRoom(richRoom());
    expect(document.querySelector('[data-attr="listing-room-apply"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="listing-room-tour"]')).toBeTruthy();
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });
});
