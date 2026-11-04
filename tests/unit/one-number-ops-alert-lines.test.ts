import { describe, expect, it } from "vitest";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { diffChannelReservations } from "@/lib/channel-calendar/channel-booking-diff";
import { digestLinesByHouse, movesByHouse } from "@/lib/one-number/checkin-digest";
import {
  applicationStartedLine,
  bookingCreatedLine,
  checkinDigestEntityId,
  checkinDigestLine,
  clockLabel,
  dayRangeLabel,
  guestFirstName,
  shortPerson,
  tourAlertLine,
} from "@/lib/one-number/ops-alert-lines";
import { toGsm7, isGsm7 } from "@/lib/one-number/segments";

function entry(over: Partial<PropertyBookingEntry>): PropertyBookingEntry {
  return {
    source: "airbnb",
    propertyId: "p-4709",
    propertyLabel: "4709A",
    roomId: "r4",
    roomLabel: "Room 4",
    summary: "Anthony",
    start: "2026-11-04",
    end: "2026-11-06",
    checkInTime: "15:00",
    checkOutTime: "11:00",
    ...over,
  };
}

describe("ops alert lines", () => {
  it("names people by first name or first name and initial only", () => {
    expect(guestFirstName("Anthony Rivera")).toBe("Anthony");
    expect(guestFirstName("Booked (Airbnb)")).toBe("Guest");
    expect(guestFirstName("Airbnb guest · HM12345")).toBe("Guest");
    expect(guestFirstName("sam@example.com")).toBe("Guest");
    expect(shortPerson("Vaishnavi Sharma")).toBe("Vaishnavi S.");
    expect(shortPerson("Arjun")).toBe("Arjun");
  });

  it("formats clock times and date ranges", () => {
    expect(clockLabel("15:00")).toBe("3 PM");
    expect(clockLabel("11:30")).toBe("11:30 AM");
    expect(clockLabel("")).toBe("");
    expect(dayRangeLabel("2026-11-06", "2026-11-09")).toBe("Nov 6–9");
    expect(dayRangeLabel("2026-11-29", "2026-12-02")).toBe("Nov 29–Dec 2");
  });

  it("writes the digest line the plan shows, and drops what does not fit", () => {
    const line = checkinDigestLine(
      "4709A",
      [{ room: "Room 4", guest: "Anthony", channel: "Airbnb", time: "15:00" }],
      [{ room: "Room 7", guest: "Kumaran", time: "11:00" }],
    );
    expect(line).toBe("Today 4709A — check-in Room 4 (Anthony, Airbnb, 3 PM). Check-out Room 7 (Kumaran, 11 AM).");
    expect(checkinDigestLine("4709A", [], [])).toBe("");
    const many = Array.from({ length: 12 }, (_, i) => ({ room: `Room ${i + 1}`, guest: "Anthony", channel: "Airbnb", time: "15:00" }));
    const cut = checkinDigestLine("4709A", many, [], 200);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut).toContain("more");
    expect(isGsm7(toGsm7(line))).toBe(true);
  });

  it("writes the booking, tour and application lines", () => {
    expect(bookingCreatedLine({ house: "5259", room: "Room 2", checkIn: "2026-11-06", checkOutExclusive: "2026-11-09", source: "Airbnb" })).toBe("New booking — 5259 Room 2, Nov 6–9 (Airbnb).");
    expect(tourAlertLine("requested", { guest: "Arjun Chopra", house: "4709A", whenIso: "2026-11-04T18:00:00Z" })).toBe("Tour requested — Arjun C., 4709A, Wed Nov 4 10:00 AM.");
    expect(tourAlertLine("cancelled", { guest: "Arjun Chopra", house: "4709A" })).toBe("Tour cancelled — Arjun C., 4709A.");
    expect(applicationStartedLine({ applicant: "Vaishnavi Sharma", house: "4709A" })).toBe("Application started — Vaishnavi S., 4709A.");
    expect(checkinDigestEntityId("p1", "2026-11-04")).toBe("p1:2026-11-04");
  });
});

describe("check-in digest grouping", () => {
  const today = "2026-11-04";

  it("groups each house's check-ins and check-outs from every booking source, skipping houses with nothing", () => {
    const entries: PropertyBookingEntry[] = [
      entry({}),
      entry({ roomId: "r7", roomLabel: "Room 7", summary: "Kumaran Iyer", source: "proplane", start: "2026-10-20", end: "2026-11-03", checkOutTime: "11:00" }),
      entry({ propertyId: "p-quiet", propertyLabel: "Quiet", start: "2026-11-10", end: "2026-11-12" }),
      entry({ propertyId: "p-5259", propertyLabel: "5259", roomLabel: "Room 2", source: "ical", channelLabel: "PadSplit", summary: "Reserved", start: "2026-11-04", end: "2026-11-05" }),
    ];
    const moves = movesByHouse(entries, today);
    expect(moves.map((m) => m.house)).toEqual(["4709A", "5259"]);
    const house = moves[0]!;
    expect(house.checkIns).toEqual([{ room: "Room 4", guest: "Anthony", channel: "Airbnb", time: "15:00" }]);
    expect(house.checkOuts).toEqual([{ room: "Room 7", guest: "Kumaran", channel: null, time: "11:00" }]);
    expect(moves[1]!.checkIns[0]).toMatchObject({ guest: "Guest", channel: "PadSplit" });
    expect(digestLinesByHouse(entries, today).map((l) => l.propertyId)).toEqual(["p-4709", "p-5259"]);
  });

  it("ignores closures, cancellations, holds and open-ended check-outs", () => {
    const entries: PropertyBookingEntry[] = [
      entry({ source: "block", summary: "Blocked", blockKind: "closed" }),
      entry({ source: "airbnb", summary: "Airbnb (Not available)" }),
      entry({ bookingStatus: "cancelled" }),
      entry({ source: "hold", summary: "Sam" }),
      entry({ start: "2026-10-01", end: "2026-11-03", openEnded: true, summary: "Lee" }),
    ];
    expect(movesByHouse(entries, today)).toEqual([]);
  });

  it("counts a duplicate reservation (channel range + the resident filed for it) once", () => {
    const entries = [entry({}), entry({ source: "proplane", summary: "Anthony" })];
    expect(movesByHouse(entries, today)[0]!.checkIns).toHaveLength(1);
  });
});

describe("a new booking is announced once", () => {
  it("a re-sync that finds the same reservation produces no created range, and the first read is a baseline", () => {
    const range = { id: "a", start: "2026-12-01", end: "2026-12-03", summary: "Reserved", sourceUid: "uid-1" } as never;
    const first = diffChannelReservations({ previous: [], next: [range], baseline: true, today: "2026-11-04" });
    expect(first.created).toEqual([]);
    const second = diffChannelReservations({ previous: [], next: [range], baseline: false, today: "2026-11-04" });
    expect(second.created).toHaveLength(1);
    const resync = diffChannelReservations({ previous: [range], next: [range], baseline: false, today: "2026-11-04" });
    expect(resync.created).toEqual([]);
  });
});
