import { describe, expect, it } from "vitest";
import { DEFAULT_PROPERTY_TIME_ZONE, propertyTimeZoneForZip, timeZoneForUsZip } from "@/lib/property-time-zone";

/**
 * Quiet hours are a promise to the person being texted, so they are read on the
 * clock where the house is. Everything used to read Los Angeles, which texted an
 * Eastern-time vendor at 8-11pm local inside their own 8pm-7am window.
 */
describe("the zone a property's quiet hours are read in", () => {
  it("places the common ZIPs", () => {
    expect(timeZoneForUsZip("98101")).toBe("America/Los_Angeles"); // Seattle
    expect(timeZoneForUsZip("11201")).toBe("America/New_York"); // Brooklyn
    expect(timeZoneForUsZip("60601")).toBe("America/Chicago"); // Chicago
    expect(timeZoneForUsZip("80202")).toBe("America/Denver"); // Denver
    expect(timeZoneForUsZip("85001")).toBe("America/Phoenix"); // Phoenix (no DST)
    expect(timeZoneForUsZip("96813")).toBe("Pacific/Honolulu");
    expect(timeZoneForUsZip("99501")).toBe("America/Anchorage");
  });

  it("reads a ZIP+4 and a formatted ZIP", () => {
    expect(timeZoneForUsZip("11201-1234")).toBe("America/New_York");
    expect(timeZoneForUsZip(" 98101 ")).toBe("America/Los_Angeles");
  });

  it("says nothing it cannot place", () => {
    expect(timeZoneForUsZip("")).toBeNull();
    expect(timeZoneForUsZip(null)).toBeNull();
    expect(timeZoneForUsZip("abc")).toBeNull();
    expect(timeZoneForUsZip("1234")).toBeNull();
  });

  it("falls back to Pacific, which is what the product assumed before", () => {
    expect(propertyTimeZoneForZip(null)).toBe(DEFAULT_PROPERTY_TIME_ZONE);
    expect(propertyTimeZoneForZip("00000")).toBe(DEFAULT_PROPERTY_TIME_ZONE);
    expect(DEFAULT_PROPERTY_TIME_ZONE).toBe("America/Los_Angeles");
  });
});
