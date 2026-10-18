import { describe, expect, it } from "vitest";
import {
  formatMoneyAmountsInLabel,
  formatRoomPriceAmount,
  roomMonthlyEquivalent,
  roomMonthlyEquivalentLabel,
} from "@/lib/room-pricing";
import { aggregateRoomRowsToPropertyCards, type RoomListingRow } from "@/lib/room-listings-catalog";
import { emptyRoom } from "@/lib/manager-listing-submission";
import { monthlyRentListingLabel } from "@/lib/rental-application/listing-fees-display";

const dailyRoom = { monthlyRent: 1050, rentBasis: "daily" as const, dailyRentPrice: 45 };
const monthlyRoom = { monthlyRent: 1150 };

describe("one monthly figure per room", () => {
  it("reads a daily room by its 30-day amount, never its stored monthlyRent", () => {
    expect(roomMonthlyEquivalent(dailyRoom)).toBe(1350);
    expect(roomMonthlyEquivalentLabel(dailyRoom)).toBe("$1,350/mo");
    expect(roomMonthlyEquivalentLabel(monthlyRoom)).toBe("$1,150/mo");
    expect(roomMonthlyEquivalentLabel({ monthlyRent: 0 })).toBe("");
    expect(roomMonthlyEquivalentLabel({ monthlyRent: 0 }, "—")).toBe("—");
  });

  it("the browse card spans every room's monthly figure, including a daily room's 30-day amount", () => {
    const row = (roomId: string, rentNumeric: number, headlineRent: number, pricePeriod: "month" | "day"): RoomListingRow =>
      ({
        key: `p:${roomId}`,
        propertyId: "p",
        roomId,
        roomName: roomId,
        floorLabel: "",
        title: "",
        streetUpper: "",
        neighborhood: "",
        priceLabel: pricePeriod === "day" ? "$45/day" : `$${headlineRent}/mo`,
        rentNumeric,
        headlineRent,
        pricePeriod,
        availabilityLabel: "",
        bathroomHint: "",
        zip: "",
        headlineAddress: "",
        fullAddress: "",
        propertyBeds: 0,
        propertyBaths: 0,
        petFriendly: false,
        descriptionBlurb: "",
        listingTags: [],
        priceOverlayLabel: "",
        availabilityRaw: "Available now",
        mediaSlides: [],
        leaseTypes: [],
      }) as unknown as RoomListingRow;
    const [card] = aggregateRoomRowsToPropertyCards([
      row("r1", 1000, 1000, "month"),
      row("r2", 1150, 1150, "month"),
      row("r3", 1350, 45, "day"),
    ]);
    expect(card!.headlineRent).toBe(1000);
    expect(card!.rentMaxNumeric).toBe(1350);
  });
});

describe("one money format", () => {
  it("groups thousands and drops cents on whole dollars", () => {
    expect(formatRoomPriceAmount(2150)).toBe("$2,150");
    expect(formatRoomPriceAmount(1000.5)).toBe("$1,000.50");
    expect(formatRoomPriceAmount(39.5)).toBe("$39.50");
  });

  it("rewrites every amount in a label", () => {
    expect(formatMoneyAmountsInLabel("from $2150/mo")).toBe("from $2,150/mo");
    expect(formatMoneyAmountsInLabel("Rent range $1000–$1350/mo")).toBe("Rent range $1,000–$1,350/mo");
    expect(formatMoneyAmountsInLabel("Rent: $1000.00/mo")).toBe("Rent: $1,000/mo");
    expect(formatMoneyAmountsInLabel("Room 1: $1150")).toBe("Room 1: $1,150");
    // A sentence comma after an amount is punctuation, not a thousands separator.
    expect(formatMoneyAmountsInLabel("Deposit $500, rent $1200")).toBe("Deposit $500, rent $1,200");
    expect(formatMoneyAmountsInLabel("Rent: $1,050, utilities included")).toBe("Rent: $1,050, utilities included");
    // Real thousands separators still group.
    expect(formatMoneyAmountsInLabel("Total $1,050,000")).toBe("Total $1,050,000");
  });

  it("the Send listing range label no longer prints cents on whole dollars", () => {
    const sub = {
      v: 1,
      bathrooms: [],
      sharedSpaces: [],
      rooms: [
        { ...emptyRoom(0), id: "a", name: "Room 1", monthlyRent: 1000 },
        { ...emptyRoom(1), id: "b", name: "Room 2", monthlyRent: 1350 },
      ],
    } as unknown as Parameters<typeof monthlyRentListingLabel>[0];
    expect(monthlyRentListingLabel(sub)).toBe("$1,000–$1,350/mo");
  });
});
