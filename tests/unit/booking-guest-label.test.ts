import { describe, expect, it } from "vitest";
import { bookingGuestLabel, bookingGuestShortLabel, channelStayName } from "@/lib/channel-calendar/booking-guest-label";

describe("bookingGuestLabel", () => {
  it("maps generic Airbnb summaries to a friendly booked label", () => {
    expect(bookingGuestLabel("Reserved")).toBe("Airbnb guest");
    expect(bookingGuestLabel("Airbnb (Not available)")).toBe("Closed on Airbnb");
  });

  it("names Booking.com when the imported summary is generic", () => {
    expect(bookingGuestLabel("Reserved", "booking_com")).toBe("Booking.com guest");
    expect(bookingGuestLabel("", "booking_com")).toBe("Booking.com guest");
  });

  it("keeps guest names from Airbnb", () => {
    expect(bookingGuestLabel("Alex M.")).toBe("Alex M.");
  });

  it("truncates short cell labels", () => {
    expect(bookingGuestShortLabel("Christopher", 8)).toBe("Christo…");
  });
});

describe("channelStayName", () => {
  const cases: Array<[string, Parameters<typeof channelStayName>[0], string]> = [
    ["Booking.com privacy-stripped", { source: "booking_com", summary: "CLOSED - Not available" }, "Booking.com guest"],
    ["Vrbo privacy-stripped", { source: "vrbo", summary: "CLOSED - Not available" }, "Vrbo guest"],
    ["Airbnb Reserved with a code", { source: "airbnb", summary: "Reserved", reservationCode: "HMABC" }, "Airbnb guest · HMABC"],
    ["Airbnb Reserved, no code", { source: "airbnb", summary: "Reserved" }, "Airbnb guest"],
    ["Airbnb blank", { source: "airbnb", summary: "" }, "Airbnb guest"],
    ["Airbnb host block", { source: "airbnb", summary: "Airbnb (Not available)" }, "Closed on Airbnb"],
    ["typed name wins", { source: "booking_com", summary: "CLOSED - Not available", guestName: "Karen Ramirez" }, "Karen Ramirez"],
    ["Other calendar real title", { source: "ical", channelLabel: "Furnished Finder", summary: "Smith family" }, "Smith family"],
    ["Other calendar Reserved", { source: "ical", channelLabel: "Furnished Finder", summary: "Reserved" }, "Furnished Finder guest"],
    ["non-channel source untouched", { source: "block", summary: "Reserved" }, "Reserved"],
  ];
  it.each(cases)("%s", (_name, entry, expected) => {
    expect(channelStayName(entry)).toBe(expected);
  });
});
