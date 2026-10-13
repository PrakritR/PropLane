import { describe, expect, it } from "vitest";
import {
  listingOffersShortStay,
  listingShortStayNightlyFrom,
  shortStayRequestAckText,
  shortStayRoomNightly,
  shortStayRoomVerdict,
  shortStayTotal,
  validateShortStayDates,
} from "@/lib/short-stay-request";

const TODAY = "2026-10-12";

describe("validateShortStayDates", () => {
  it("accepts a normal stay and counts nights check-out exclusive", () => {
    expect(validateShortStayDates("2026-10-20", "2026-10-24", TODAY)).toEqual({ ok: true, checkIn: "2026-10-20", checkOut: "2026-10-24", nights: 4 });
  });
  it("refuses bad, reversed, past, too-far and too-long ranges", () => {
    expect(validateShortStayDates("nope", "2026-10-24", TODAY).ok).toBe(false);
    expect(validateShortStayDates("2026-10-24", "2026-10-24", TODAY).ok).toBe(false);
    expect(validateShortStayDates("2026-10-11", "2026-10-14", TODAY).ok).toBe(false);
    expect(validateShortStayDates("2027-06-01", "2027-06-03", TODAY).ok).toBe(false);
    expect(validateShortStayDates("2026-10-20", "2026-11-18", TODAY).ok).toBe(false);
    expect(validateShortStayDates("2026-10-20", "2026-11-17", TODAY).ok).toBe(true);
  });
});

describe("rates and totals", () => {
  it("prefers the room's short-term rate, then its daily basis, then the listing's nightly cost", () => {
    expect(shortStayRoomNightly({ shortTermRent: "60", rentBasis: "daily", dailyRentPrice: 50 }, "40")).toBe(60);
    expect(shortStayRoomNightly({ rentBasis: "daily", dailyRentPrice: 50 }, "40")).toBe(50);
    expect(shortStayRoomNightly({}, "$55")).toBe(55);
    expect(shortStayRoomNightly({}, "")).toBe(0);
  });
  it("takes the lowest rate and the offered flag from the listing", () => {
    const sub = { shortTermRentalsAllowed: true, shortTermDailyCost: "70", rooms: [{ rentBasis: "daily" as const, dailyRentPrice: 55 }, {}] };
    expect(listingShortStayNightlyFrom(sub)).toBe(55);
    expect(listingOffersShortStay(sub)).toBe(true);
    expect(listingOffersShortStay({ rooms: [{}] })).toBe(false);
    expect(listingOffersShortStay({ rooms: [{ rentBasis: "daily", dailyRentPrice: 55 }] })).toBe(true);
    expect(shortStayTotal(55, 4)).toBe(220);
  });
  it("writes the guest's confirmation text", () => {
    expect(
      shortStayRequestAckText({ guestName: "Priya Shah", roomLabel: "Room 3", propertyLabel: "5257 Brooklyn Ave", checkIn: "2026-10-20", checkOut: "2026-10-24", total: 220, ownerFirstName: "Ambika" }),
    ).toBe("Got it, Priya — Room 3 at 5257 Brooklyn Ave, Oct 20–24 ($220). Ambika will confirm shortly. Reply here with questions.");
  });
});

describe("shortStayRoomVerdict (range filter + dimming copy)", () => {
  const booked = [{ start: "2026-10-13", end: "2026-10-16", count: 1 }];
  it("is free when the nights miss the booked span and checkout is exclusive", () => {
    expect(shortStayRoomVerdict({ spans: booked, capacity: 1, checkIn: "2026-10-20", checkOut: "2026-10-24" })).toEqual({ free: true });
    expect(shortStayRoomVerdict({ spans: booked, capacity: 1, checkIn: "2026-10-17", checkOut: "2026-10-20" })).toEqual({ free: true });
    expect(shortStayRoomVerdict({ spans: [{ start: "2026-10-24", end: null, count: 1 }], capacity: 1, checkIn: "2026-10-20", checkOut: "2026-10-24" })).toEqual({ free: true });
  });
  it("says when it is booked and when it frees up", () => {
    const verdict = shortStayRoomVerdict({ spans: booked, capacity: 1, checkIn: "2026-10-14", checkOut: "2026-10-18" });
    expect(verdict).toEqual({ free: false, label: "Booked Oct 14 – Oct 17 · free from Oct 17", freeFrom: "2026-10-17" });
  });
  it("keeps a shared room free until its last bed goes", () => {
    expect(shortStayRoomVerdict({ spans: booked, capacity: 2, checkIn: "2026-10-14", checkOut: "2026-10-18" })).toEqual({ free: true });
  });
  it("blocks a room that is not available before its move-in date", () => {
    const verdict = shortStayRoomVerdict({ spans: [], capacity: 1, availableFrom: "2026-11-01", checkIn: "2026-10-20", checkOut: "2026-10-22" });
    expect(verdict.free).toBe(false);
  });
});
