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

/** The rent figure in the popup's header (room name left, figure right). */
function rentFigure(): HTMLElement {
  const node = document.querySelector('[data-attr="listing-room-rent"]');
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

describe("room detail modal — rent", () => {
  it("shows the room's rent, formatted like roomHeadlinePriceLabel everywhere else", () => {
    renderRoom(roomRow());
    expect(rentFigure().textContent).toBe("$1,150/mo");
  });

  it("uses the daily suffix for a daily-priced room", () => {
    renderRoom(
      roomRow({ price: "$40.50/day", pricePeriod: "day", priceHeadlineAmount: 40.5 }),
    );
    expect(rentFigure().textContent).toBe("$40.50/day");
  });

  it("leads the popup in its header, so utilities can never read as the price of the room", () => {
    renderRoom(roomRow());
    const header = screen.getByText("Room 1").closest("header") as HTMLElement;
    expect(header.contains(rentFigure())).toBe(true);
    const facts = document.querySelector('[data-attr="listing-room-facts"]') as HTMLElement;
    expect(Array.from(facts.querySelectorAll("dt")).map((n) => n.textContent)).toEqual(["Floor", "Bathroom", "Utilities (est.)", "Status"]);
    expect(within(facts).getByText("$150/mo est.")).toBeTruthy();
    expect(facts.textContent).not.toContain("$1,150");
  });

  it("says 'Not set' rather than '$0' when the room has no rent", () => {
    renderRoom(roomRow({ price: "$0", priceHeadlineAmount: undefined }));
    const figure = rentFigure();
    expect(within(figure).getByText("Not set")).toBeTruthy();
    expect(figure.textContent).not.toContain("$0");
  });

  it.each(["$0.00", "$0/mo", "—", "   "])(
    "says 'Not set' for the meaningless price label %j",
    (price) => {
      renderRoom(roomRow({ price, priceHeadlineAmount: undefined }));
      expect(within(rentFigure()).getByText("Not set")).toBeTruthy();
    },
  );

  it("falls back to the row's own price when the row carries no headline amount", () => {
    renderRoom(roomRow({ price: "$775/month", priceHeadlineAmount: undefined }));
    const figure = rentFigure();
    expect(within(figure).getByText("$775/month")).toBeTruthy();
    expect(figure.textContent).not.toContain("Not set");
  });

  it("keeps an entire-home room's descriptive label instead of reporting it as unset", () => {
    renderRoom(roomRow({ price: "Included", priceHeadlineAmount: undefined }));
    expect(within(rentFigure()).getByText("Included")).toBeTruthy();
  });

  it("renders a single-month availability calendar with month navigation in the room modal", () => {
    renderRoom(roomRow());
    expect(screen.getByText("Availability")).toBeTruthy();
    expect(screen.queryByText(/Green dates are open and red dates are unavailable/)).toBeNull();
    expect(screen.getByLabelText("Previous month")).toBeTruthy();
    expect(screen.getByLabelText("Next month")).toBeTruthy();
    expect(screen.getAllByText("Available").length).toBeGreaterThan(0);
  });
});
