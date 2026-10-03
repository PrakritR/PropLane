// @vitest-environment jsdom
/**
 * The listing Rooms table is fixed-layout: a long room cell ("Shared room - 2 beds - 2 open")
 * used to run into Floor, and "Bathroom 3" into the Available dot, because those cells refused
 * to wrap or clip. Room wraps inside its column; Floor, Bath and Available clip with the full
 * text on `title`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SpacesInteractive } from "@/components/marketing/listing-detail-tables-client";
import type { ListingFloorCard, ListingRoomRow } from "@/data/listing-rich-content";

vi.mock("@/hooks/use-listing-public-occupancy", () => ({
  useListingPublicOccupancy: () => ({ rooms: [] }),
}));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));

const room = {
  id: "room-1",
  name: "Room 1 with a rather long listing name",
  detail: "",
  price: "$1,050/mo",
  occupancyCapacity: 2,
  availability: "Available now",
  bathroomShareCount: 3,
  modal: { photoUrls: [], bathroomShortLabel: "Bathroom 3" },
} as unknown as ListingRoomRow;

const floors = [
  { floorLabel: "Ground floor (basement level)", fromPrice: "$1,050", roomCount: 1, rooms: [room] },
] as unknown as ListingFloorCard[];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("listing rooms table columns", () => {
  it("wraps the room cell and clips Floor and Bath with their full text on title", () => {
    render(<SpacesInteractive floorPlans={floors} bathrooms={[]} sharedSpaces={[]} listingPropertyId="p1" />);
    const row = document.querySelector("table tbody tr") as HTMLElement;
    const cells = [...row.querySelectorAll("td")];
    // photo, room, floor, bath, available, rent, details
    const [, roomCell, floorCell, bathCell, availCell] = cells;
    expect(roomCell!.className).not.toContain("whitespace-nowrap");
    expect(roomCell!.className).toContain("break-words");
    expect(roomCell!.textContent).toContain("Room 1 with a rather long listing name");

    for (const cell of [floorCell!, bathCell!]) {
      expect(cell.className).toContain("overflow-hidden");
      expect(cell.className).toContain("text-ellipsis");
      expect(cell.className).toContain("whitespace-nowrap");
    }
    expect(floorCell!.getAttribute("title")).toBe("Ground floor (basement level)");
    expect(bathCell!.getAttribute("title")).toBe(bathCell!.textContent);
    expect(availCell!.className).toContain("overflow-hidden");
  });

  it("gives Bath and Available real widths", () => {
    render(<SpacesInteractive floorPlans={floors} bathrooms={[]} sharedSpaces={[]} listingPropertyId="p1" />);
    const heads = [...document.querySelectorAll("table thead th")].map((th) => th.className);
    const widthOf = (label: string) => {
      const th = [...document.querySelectorAll("table thead th")].find((el) => el.textContent === label)!;
      return /w-\[(\d+)%\]/.exec(th.className)?.[1];
    };
    expect(heads.length).toBeGreaterThan(5);
    expect(Number(widthOf("Bath"))).toBeGreaterThanOrEqual(15);
    expect(Number(widthOf("Available"))).toBeGreaterThanOrEqual(16);
    expect(Number(widthOf("Rent"))).toBeGreaterThanOrEqual(14); // "$10,502/mo" clears the Details button
    expect(Number(widthOf("Room"))).toBeGreaterThanOrEqual(25);
    expect(Number(widthOf("Floor"))).toBeGreaterThanOrEqual(14); // "2nd floor" never truncates
  });
});
