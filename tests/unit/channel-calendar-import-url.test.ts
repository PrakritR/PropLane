/**
 * Regression: a mistyped Airbnb import URL must be a 400 the manager can read,
 * not a 500 the Link Airbnb modal renders as nothing.
 *
 * The validation threw a plain `Error`, which fell into the route's generic
 * catch and answered 500. The modal showed no inline message, so clicking
 * "Save & sync" with a bad link looked like the button simply did nothing.
 */
import { describe, expect, it } from "vitest";
import {
  ChannelCalendarInputError,
  channelCalendarProviderLabel,
  channelImportUrlErrorMessage,
  isChannelCalendarInputError,
  isValidAirbnbImportUrl,
  isValidBookingComImportUrl,
  isValidChannelImportUrl,
  normalizeAirbnbImportUrl,
} from "@/lib/channel-calendar/airbnb-url";

describe("isValidAirbnbImportUrl", () => {
  it("accepts a real Airbnb iCal export link", () => {
    expect(isValidAirbnbImportUrl("https://www.airbnb.com/calendar/ical/12345.ics?s=abc")).toBe(true);
  });

  it("rejects a non-Airbnb host — the shape that used to 500", () => {
    expect(isValidAirbnbImportUrl("http://evil.example.com/not-a-calendar")).toBe(false);
    expect(isValidAirbnbImportUrl("https://evil.example.com/calendar/ical/1.ics")).toBe(false);
  });

  it("requires https and the calendar/ical path", () => {
    expect(isValidAirbnbImportUrl("http://www.airbnb.com/calendar/ical/1.ics")).toBe(false);
    expect(isValidAirbnbImportUrl("https://www.airbnb.com/rooms/12345")).toBe(false);
  });

  it("rejects junk without throwing", () => {
    expect(isValidAirbnbImportUrl("")).toBe(false);
    expect(isValidAirbnbImportUrl("not a url")).toBe(false);
    expect(normalizeAirbnbImportUrl("  https://www.airbnb.com/calendar/ical/1.ics  ")).toBe(
      "https://www.airbnb.com/calendar/ical/1.ics",
    );
  });
});

describe("isValidBookingComImportUrl", () => {
  it("accepts Booking.com export and admin iCal links", () => {
    expect(isValidBookingComImportUrl("https://ical.booking.com/v1/export?t=abc")).toBe(true);
    expect(isValidBookingComImportUrl("https://admin.booking.com/hotel/hoteladmin/ical.html?t=abc")).toBe(true);
  });

  it("rejects Airbnb URLs and other hosts", () => {
    expect(isValidBookingComImportUrl("https://www.airbnb.com/calendar/ical/12345.ics?s=abc")).toBe(false);
    expect(isValidBookingComImportUrl("https://evil.example.com/v1/export?t=abc")).toBe(false);
    expect(isValidBookingComImportUrl("http://ical.booking.com/v1/export?t=abc")).toBe(false);
  });
});

describe("isValidChannelImportUrl", () => {
  it("routes each provider to its own allowlist", () => {
    expect(
      isValidChannelImportUrl("airbnb", "https://www.airbnb.com/calendar/ical/12345.ics?s=abc"),
    ).toBe(true);
    expect(isValidChannelImportUrl("booking_com", "https://ical.booking.com/v1/export?t=abc")).toBe(true);
    expect(isValidChannelImportUrl("airbnb", "https://ical.booking.com/v1/export?t=abc")).toBe(false);
    expect(
      isValidChannelImportUrl("booking_com", "https://www.airbnb.com/calendar/ical/12345.ics?s=abc"),
    ).toBe(false);
  });

  it("names the channel in the paste error", () => {
    expect(channelCalendarProviderLabel("booking_com")).toBe("Booking.com");
    expect(channelImportUrlErrorMessage("booking_com")).toContain("Booking.com");
    expect(channelImportUrlErrorMessage("airbnb")).toContain("Airbnb");
  });
});

describe("ChannelCalendarInputError", () => {
  it("is recognisable across module boundaries so routes can map it to 400", () => {
    const err = new ChannelCalendarInputError("bad link");
    expect(isChannelCalendarInputError(err)).toBe(true);
    expect(err.field).toBe("importUrl");
  });

  it("does not claim ordinary errors", () => {
    expect(isChannelCalendarInputError(new Error("database exploded"))).toBe(false);
    expect(isChannelCalendarInputError("nope")).toBe(false);
    expect(isChannelCalendarInputError(null)).toBe(false);
  });
});
