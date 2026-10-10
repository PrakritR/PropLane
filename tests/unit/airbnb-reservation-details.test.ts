import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseIcsCalendar } from "@/lib/ical/parse";
import {
  airbnbReservationUrl,
  parseReservationDescription,
  reservationCodeFromUrl,
} from "@/lib/channel-calendar/reservation-details";
import { icalEventsToImportedRanges } from "@/lib/channel-calendar/sync.server";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { bookingEntryGuestLabel, bookingEntryNamedLabel } from "@/lib/channel-calendar/booking-guest-label";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:uid-reserved@airbnb.com",
  "SUMMARY:Reserved",
  // Folded the way Airbnb folds long lines, with escaped newline and comma.
  "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de",
  " tails/HMABCDEFGH\\nPhone Number (Last 4 Digits): 1234",
  "DTSTART;VALUE=DATE:20261010",
  "DTEND;VALUE=DATE:20261013",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:uid-block@airbnb.com",
  "SUMMARY:Airbnb (Not available)",
  "DTSTART;VALUE=DATE:20261020",
  "DTEND;VALUE=DATE:20261022",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("iCal DESCRIPTION", () => {
  it("unfolds lines and unescapes \\n \\, \; \\\\", () => {
    const [event] = parseIcsCalendar(FEED);
    expect(event.description).toBe(
      "Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCDEFGH\nPhone Number (Last 4 Digits): 1234",
    );
    const escaped = parseIcsCalendar(
      "BEGIN:VEVENT\nUID:u\nDESCRIPTION:a\\, b\; c\\\\d\nDTSTART:20261010\nEND:VEVENT",
    );
    expect(escaped[0].description).toBe("a, b; c\\d");
  });

  it("leaves description absent when the event has none", () => {
    expect(parseIcsCalendar(FEED)[1].description).toBeUndefined();
  });
});

describe("reservation code and phone suffix", () => {
  it("reads the code from an airbnb.com reservation URL and the 4 phone digits", () => {
    expect(parseReservationDescription(parseIcsCalendar(FEED)[0].description)).toEqual({
      reservationCode: "HMABCDEFGH",
      phoneLast4: "1234",
    });
  });

  it("accepts the bare airbnb.com host", () => {
    expect(reservationCodeFromUrl("https://airbnb.com/hosting/reservations/details/HMZZ99AA11")).toBe("HMZZ99AA11");
  });

  it("rejects look-alike hosts, other schemes, other paths and bad codes", () => {
    for (const url of [
      "https://www.airbnb.com.evil.test/hosting/reservations/details/HMABCDEFGH",
      "https://evil.test/www.airbnb.com/hosting/reservations/details/HMABCDEFGH",
      "https://notairbnb.com/hosting/reservations/details/HMABCDEFGH",
      "https://user@www.airbnb.com/hosting/reservations/details/HMABCDEFGH",
      "http://www.airbnb.com/hosting/reservations/details/HMABCDEFGH",
      "https://www.airbnb.com/rooms/HMABCDEFGH",
      "https://www.airbnb.com/hosting/reservations/details/HMABC",
      "https://www.airbnb.com/hosting/reservations/details/hmabcdefgh",
      "https://www.airbnb.com/hosting/reservations/details/XXABCDEFGH",
    ]) {
      expect(reservationCodeFromUrl(url), url).toBeNull();
    }
    expect(parseReservationDescription("Reservation URL: https://evil.test/hosting/reservations/details/HMABCDEFGH")).toEqual({});
  });

  it("requires exactly four digits after Last 4 Digits", () => {
    expect(parseReservationDescription("Phone Number (Last 4 Digits): 123").phoneLast4).toBeUndefined();
    expect(parseReservationDescription("Phone Number (Last 4 Digits): 12345").phoneLast4).toBeUndefined();
    expect(parseReservationDescription("Phone Number (Last 4 Digits): abcd").phoneLast4).toBeUndefined();
    expect(parseReservationDescription("Phone Number (Last 4 Digits): 0042").phoneLast4).toBe("0042");
  });

  it("rebuilds the Airbnb link from the code only", () => {
    expect(airbnbReservationUrl("HMABCDEFGH")).toBe("https://www.airbnb.com/hosting/reservations/details/HMABCDEFGH");
    expect(airbnbReservationUrl("https://evil.test")).toBeNull();
    expect(airbnbReservationUrl(undefined)).toBeNull();
  });
});

describe("icalEventsToImportedRanges", () => {
  it("stores the code and phone suffix, never the raw description", () => {
    const [reserved, block] = icalEventsToImportedRanges(parseIcsCalendar(FEED));
    expect(reserved).toMatchObject({ sourceUid: "uid-reserved@airbnb.com", summary: "Reserved", reservationCode: "HMABCDEFGH", phoneLast4: "1234" });
    expect(JSON.stringify(reserved)).not.toContain("Reservation URL");
    expect(reserved).not.toHaveProperty("description");
    expect(block).toMatchObject({ hostBlock: true });
    expect(block).not.toHaveProperty("reservationCode");
  });

  it("survives the stored-row round trip and drops malformed values", () => {
    const row = parseConnectionRow({
      id: "c", manager_user_id: "m", property_id: "p", room_id: "r", export_token: "t",
      imported_ranges: [
        { id: "a", sourceUid: "a", start: "2026-10-10", end: "2026-10-12", summary: "Reserved", reservationCode: "HMABCDEFGH", phoneLast4: "1234" },
        { id: "b", sourceUid: "b", start: "2026-10-14", end: "2026-10-15", summary: "Reserved", reservationCode: "https://evil.test", phoneLast4: "12" },
      ],
    });
    expect(row.imported_ranges[0]).toMatchObject({ reservationCode: "HMABCDEFGH", phoneLast4: "1234" });
    expect(row.imported_ranges[1]).not.toHaveProperty("reservationCode");
    expect(row.imported_ranges[1]).not.toHaveProperty("phoneLast4");
  });
});

describe("guest label precedence", () => {
  const stay = { source: "airbnb", summary: "Reserved", reservationCode: "HMABCDEFGH" };

  it("is typed name, then Airbnb guest + code, then the existing label", () => {
    expect(bookingEntryGuestLabel({ ...stay, guestName: "  Maria Lopez " })).toBe("Maria Lopez");
    expect(bookingEntryGuestLabel(stay)).toBe("Airbnb guest · HMABCDEFGH");
    expect(bookingEntryGuestLabel({ source: "airbnb", summary: "Reserved" })).toBe("Booked (Airbnb)");
    expect(bookingEntryGuestLabel({ source: "booking_com", summary: "Reserved" })).toBe("Booked (Booking.com)");
  });

  it("keeps a real feed name over the code label, and host blocks over everything", () => {
    expect(bookingEntryGuestLabel({ ...stay, summary: "Alex M." })).toBe("Alex M.");
    expect(bookingEntryGuestLabel({ source: "airbnb", summary: "Airbnb (Not available)", guestName: "Nope", reservationCode: "HMABCDEFGH" })).toBe("Airbnb block");
    expect(bookingEntryNamedLabel({ source: "airbnb", summary: "Airbnb (Not available)", guestName: "Nope" })).toBeNull();
  });

  it("leaves PropLane stays alone", () => {
    expect(bookingEntryGuestLabel({ source: "proplane", summary: "Resident One", guestName: "x" })).toBe("Resident One");
  });
});
