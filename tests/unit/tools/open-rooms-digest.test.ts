import { describe, expect, it } from "vitest";
import { buildOpenRoomsDigest, isOpenRoom, roomPhrase } from "@/lib/tools/domains/open-rooms-digest";

const URL5257 = "https://example.test/rent/listings/5257-brooklyn-ave-ne-abc123";

describe("open rooms digest", () => {
  it("lists only verified-open rooms, one line per home, with price, date, deposit, facts and the link", () => {
    const digest = buildOpenRoomsDigest([
      {
        title: "5257 Brooklyn",
        address: "5257 Brooklyn Ave NE",
        neighborhood: "U District",
        listingUrl: URL5257,
        petFriendly: true,
        rooms: [
          { name: "Room 7", monthlyRent: 1200, currentAvailabilityVerified: true, freeNow: true, securityDeposit: "500", furnishing: "Furnished" },
          { name: "Room 8", monthlyRent: 1100, currentAvailabilityVerified: true, freeNow: false, freeFrom: "2026-12-05" },
          { name: "Room 9", monthlyRent: 1000, currentAvailabilityVerified: false, freeNow: null },
          { name: "Room 2", monthlyRent: 900, currentAvailabilityVerified: true, freeNow: false, freeFrom: null },
        ],
      },
      { title: "Full house", listingUrl: "https://example.test/rent/listings/full-1", rooms: [{ name: "A", monthlyRent: 800, currentAvailabilityVerified: false }] },
    ]);
    expect(digest.homeCount).toBe(1);
    expect(digest.openRoomCount).toBe(2);
    expect(digest.lines).toEqual([
      `5257 Brooklyn Ave NE, U District: Room 7 $1,200/mo open now (deposit $500, furnished); Room 8 $1,100/mo from Dec 5. Pets welcome. ${URL5257}`,
    ]);
    expect(digest.photoOffer).toMatch(/photos/i);
  });

  it("says nothing is open (empty lines) rather than inventing a room", () => {
    const digest = buildOpenRoomsDigest([{ title: "X", listingUrl: URL5257, rooms: [{ name: "R", monthlyRent: 1, currentAvailabilityVerified: false }] }]);
    expect(digest.lines).toEqual([]);
    expect(digest.openRoomCount).toBe(0);
  });

  it("never lists a home without its link and caps the homes", () => {
    const homes = Array.from({ length: 9 }, (_, i) => ({
      title: `H${i}`,
      listingUrl: i === 0 ? "" : `https://example.test/rent/listings/h${i}`,
      rooms: [{ name: "R", monthlyRent: 700, currentAvailabilityVerified: true, freeNow: true }],
    }));
    const digest = buildOpenRoomsDigest(homes, 3);
    expect(digest.lines).toHaveLength(3);
    expect(digest.lines.some((l) => l.startsWith("H0"))).toBe(false);
  });

  it("prices a daily room per night and keeps an unverified room closed", () => {
    expect(roomPhrase({ name: "Suite", monthlyRent: null, rentBasis: "daily", dailyRentPrice: 85, currentAvailabilityVerified: true, freeNow: true })).toBe("Suite $85/night open now");
    expect(isOpenRoom({ name: "x", monthlyRent: 1, currentAvailabilityVerified: false, freeNow: true })).toBe(false);
  });
});
