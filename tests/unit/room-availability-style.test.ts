// One reading of a room's availability copy for every surface (PLAN-0914-2124,
// review finding R15): the browse card pill, the detail tiles and the
// traffic-light pills must agree, so "Available from Oct 1, 2099" can never be
// "Available now" on one page and "Oct 1" on another.
import { describe, expect, it } from "vitest";
import {
  classifyRoomOpening,
  earliestRoomOpening,
  parseAvailabilityDate,
  roomAvailabilityTone,
} from "@/lib/room-availability-style";

describe("classifyRoomOpening", () => {
  it("reads now, a passed date, and 'now until' as now", () => {
    expect(classifyRoomOpening("Available now").kind).toBe("now");
    expect(classifyRoomOpening("Available now until Sept 19").kind).toBe("now");
    expect(classifyRoomOpening("Available after Oct 1, 2001").kind).toBe("now");
    expect(classifyRoomOpening("Available").kind).toBe("now");
    expect(classifyRoomOpening("immediately").kind).toBe("now");
  });

  it("reads any future date as later, whatever word introduces it", () => {
    for (const text of ["Available from Oct 1, 2099", "Available after Oct 1, 2099", "Available on Oct 1, 2099", "Available starting 10/01/2099", "Available Oct 1, 2099"]) {
      const opening = classifyRoomOpening(text);
      expect(opening.kind, text).toBe("later");
      expect(opening.date?.getFullYear(), text).toBe(2099);
    }
  });

  it("keeps undated future copy as later without a date", () => {
    expect(classifyRoomOpening("Available after December")).toEqual({ kind: "later", date: null });
    expect(classifyRoomOpening("Waitlist")).toEqual({ kind: "later", date: null });
    expect(classifyRoomOpening("Available soon")).toEqual({ kind: "later", date: null });
  });

  it("reads unavailable wording and says nothing about blank copy", () => {
    expect(classifyRoomOpening("Not available").kind).toBe("unavailable");
    expect(classifyRoomOpening("Leased").kind).toBe("unavailable");
    expect(classifyRoomOpening("").kind).toBe("unknown");
    expect(classifyRoomOpening("Corner room").kind).toBe("unknown");
  });
});

describe("parseAvailabilityDate", () => {
  it("parses named and numeric dates and rolls a yearless day forward", () => {
    expect(parseAvailabilityDate("Available from Oct 1, 2099")?.toISOString().slice(0, 10)).toBe("2099-10-01");
    expect(parseAvailabilityDate("10/01/2099")?.getFullYear()).toBe(2099);
    const yearless = parseAvailabilityDate("Available on Jan 5");
    expect(yearless).not.toBeNull();
    expect(yearless!.getTime()).toBeGreaterThanOrEqual(new Date(new Date().getFullYear(), 0, 1).getTime());
    expect(parseAvailabilityDate("Available after December")).toBeNull();
  });
});

describe("roomAvailabilityTone", () => {
  it("maps the shared reading onto the traffic-light tones", () => {
    expect(roomAvailabilityTone("Available now")).toBe("available");
    expect(roomAvailabilityTone("Available from Oct 1, 2099")).toBe("future");
    expect(roomAvailabilityTone("Available after December")).toBe("future");
    expect(roomAvailabilityTone("Not available")).toBe("unavailable");
    expect(roomAvailabilityTone("Corner room")).toBe("neutral");
  });
});

describe("earliestRoomOpening", () => {
  it("orders now, then dated openings chronologically, then undated text", () => {
    expect(earliestRoomOpening(["Available after Dec 1, 2099", "Available now"])).toBe("Available now");
    expect(earliestRoomOpening(["Available after Dec 1, 2099", "Available from Oct 1, 2099"])).toBe("Available from Oct 1, 2099");
    expect(earliestRoomOpening(["Available after December", "Available from Oct 1, 2099"])).toBe("Available from Oct 1, 2099");
    expect(earliestRoomOpening(["Waitlist", "Available soon"])).toBe("Waitlist");
    expect(earliestRoomOpening(["Not available", "—", ""])).toBeNull();
  });
});
