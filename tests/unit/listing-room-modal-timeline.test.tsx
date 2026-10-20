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
    expect(screen.getByText("Availability timeline")).toBeTruthy();
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
