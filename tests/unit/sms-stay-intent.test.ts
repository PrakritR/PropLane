import { describe, expect, it } from "vitest";
import { detectStayIntent, parseStayDates } from "@/lib/short-stay/sms-stay-intent";

const TODAY = "2026-10-19"; // a Monday

describe("detectStayIntent", () => {
  it.each([
    "I need a room for 2 weeks",
    "short term stay Nov 3-10",
    "do you have anything nightly?",
    "for a month only",
    "Airbnb style place near UW",
    "looking for a place for 3 nights",
    "need somewhere for a few nights",
  ])("short: %s", (text) => expect(detectStayIntent(text)).toBe("short"));

  it.each([
    "I want a 12 month lease",
    "long term room in capitol hill please",
    "how do I apply?",
    "looking for a one year place",
  ])("long: %s", (text) => expect(detectStayIntent(text)).toBe("long"));

  it("an explicit short word beats a lease word, an explicit lease beats a loose length", () => {
    expect(detectStayIntent("short term, no lease")).toBe("short");
    expect(detectStayIntent("a lease starting in 2 weeks")).toBe("long");
  });

  it("says unknown when nothing decides it", () => {
    expect(detectStayIntent("hey is there any house available")).toBe("unknown");
  });
});

describe("parseStayDates (Pacific today)", () => {
  it("reads 'Nov 3-10' as check-in Nov 3 and check-out Nov 10", () => {
    expect(parseStayDates("short term stay Nov 3-10", TODAY)).toEqual({ checkIn: "2026-11-03", checkOut: "2026-11-10", nights: 7 });
  });
  it("reads two month names and numeric ranges", () => {
    expect(parseStayDates("november 28 to dec 2", TODAY)).toMatchObject({ checkIn: "2026-11-28", checkOut: "2026-12-02", nights: 4 });
    expect(parseStayDates("11/3-11/10", TODAY)).toMatchObject({ checkIn: "2026-11-03", checkOut: "2026-11-10" });
    expect(parseStayDates("11/3 - 10", TODAY)).toMatchObject({ checkIn: "2026-11-03", checkOut: "2026-11-10" });
  });
  it("a date already gone this year means next year, and a range can cross the new year", () => {
    expect(parseStayDates("jan 5-9", TODAY)).toMatchObject({ checkIn: "2027-01-05", checkOut: "2027-01-09" });
    expect(parseStayDates("dec 28 to jan 3", TODAY)).toMatchObject({ checkIn: "2026-12-28", checkOut: "2027-01-03" });
    expect(parseStayDates("oct 19-22", TODAY)).toMatchObject({ checkIn: "2026-10-19", checkOut: "2026-10-22" });
  });
  it("a length with no start is only a length", () => {
    expect(parseStayDates("a room for 2 weeks", TODAY)).toEqual({ checkIn: null, checkOut: null, nights: 14 });
    expect(parseStayDates("for a month only", TODAY)).toEqual({ checkIn: null, checkOut: null, nights: 30 });
  });
  it("a start plus a length gives a check-out", () => {
    expect(parseStayDates("tomorrow for 3 nights", TODAY)).toEqual({ checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3 });
    expect(parseStayDates("starting nov 3 for two weeks", TODAY)).toEqual({ checkIn: "2026-11-03", checkOut: "2026-11-17", nights: 14 });
    expect(parseStayDates("next friday for a week", TODAY)).toEqual({ checkIn: "2026-10-23", checkOut: "2026-10-30", nights: 7 });
  });
  it("an impossible date is not a date", () => {
    expect(parseStayDates("feb 30-31", TODAY).checkIn).toBe(null);
    expect(parseStayDates("hello", TODAY)).toEqual({ checkIn: null, checkOut: null, nights: null });
  });
});
