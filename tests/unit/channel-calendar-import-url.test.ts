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
  isChannelCalendarInputError,
  isValidAirbnbImportUrl,
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
