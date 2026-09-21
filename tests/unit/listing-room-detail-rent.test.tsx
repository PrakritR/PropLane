// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ListingDetailModal } from "@/components/marketing/listing-detail-tables-client";
import type { ListingRoomRow } from "@/data/listing-rich-content";

vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return { ...actual, getRoomUnavailabilityWindows: () => [] };
});

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}));

afterEach(cleanup);

function roomRow(overrides: Partial<ListingRoomRow> = {}): ListingRoomRow {
  return {
    id: "room-1",
    name: "Room 1",
    detail: "Listed by manager",
    utilitiesEstimate: "$150/mo est.",
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

/** The stat card whose uppercase label is exactly `label`. */
function statCard(label: string): HTMLElement {
  const labelNode = screen.getByText(label);
  const card = labelNode.parentElement;
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

describe("room detail modal — rent", () => {
  it("shows the room's rent, formatted like roomHeadlinePriceLabel everywhere else", () => {
    renderRoom(roomRow());
    expect(within(statCard("Rent")).getByText("$1,150/mo")).toBeTruthy();
  });

  it("uses the daily suffix for a daily-priced room", () => {
    renderRoom(
      roomRow({ price: "$40.50/day", pricePeriod: "day", priceHeadlineAmount: 40.5 }),
    );
    expect(within(statCard("Rent")).getByText("$40.50/day")).toBeTruthy();
  });

  it("leads the stat grid, so utilities can never read as the price of the room", () => {
    renderRoom(roomRow());
    const labels = screen
      .getAllByText(/^(Rent|Floor|Utilities)$/)
      .map((n) => n.textContent);
    expect(labels).toEqual(["Rent", "Floor", "Utilities"]);
  });

  it("says 'Not set' rather than '$0' when the room has no rent", () => {
    renderRoom(roomRow({ price: "$0", priceHeadlineAmount: undefined }));
    const card = statCard("Rent");
    expect(within(card).getByText("Not set")).toBeTruthy();
    expect(card.textContent).not.toContain("$0");
  });

  it.each(["$0.00", "$0/mo", "—", "   "])(
    "says 'Not set' for the meaningless price label %j",
    (price) => {
      renderRoom(roomRow({ price, priceHeadlineAmount: undefined }));
      expect(within(statCard("Rent")).getByText("Not set")).toBeTruthy();
    },
  );

  it("falls back to the row's own price when the row carries no headline amount", () => {
    renderRoom(roomRow({ price: "$775/month", priceHeadlineAmount: undefined }));
    const card = statCard("Rent");
    expect(within(card).getByText("$775/month")).toBeTruthy();
    expect(card.textContent).not.toContain("Not set");
  });

  it("keeps an entire-home room's descriptive label instead of reporting it as unset", () => {
    renderRoom(roomRow({ price: "Included", priceHeadlineAmount: undefined }));
    expect(within(statCard("Rent")).getByText("Included")).toBeTruthy();
  });

  it("renders a single-month availability calendar with month navigation in the room modal", () => {
    renderRoom(roomRow());
    expect(screen.getByText("Availability timeline")).toBeTruthy();
    expect(screen.getByText(/Green dates are open and red dates are unavailable/)).toBeTruthy();
    expect(screen.getByLabelText("Previous month")).toBeTruthy();
    expect(screen.getByLabelText("Next month")).toBeTruthy();
    expect(screen.getAllByText("Available").length).toBeGreaterThan(0);
  });
});
