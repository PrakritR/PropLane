import { describe, expect, it } from "vitest";
import { airbnbOpenUrlForEntry, reservationCodeForEntry } from "@/lib/channel-calendar/reservation-code";
import { parseIcsCalendar } from "@/lib/ical/parse";
import { parseReservationDescription } from "@/lib/channel-calendar/reservation-details";

const URL_PREFIX = "https://www.airbnb.com/hosting/reservations/details/";

describe("reservationCodeForEntry", () => {
  it("reads the code the sync stored on the entry", () => {
    expect(reservationCodeForEntry({ source: "airbnb", summary: "Reserved", reservationCode: "HM8F9S4DWC" })).toBe("HM8F9S4DWC");
  });

  it("falls back to the reservation URL, then to the summary", () => {
    expect(reservationCodeForEntry({ source: "airbnb", summary: "Reserved", reservationUrl: `${URL_PREFIX}HMABCDEFGH` })).toBe("HMABCDEFGH");
    expect(reservationCodeForEntry({ source: "airbnb", summary: `Reservation URL: ${URL_PREFIX}HMQWERTY12` })).toBe("HMQWERTY12");
    expect(reservationCodeForEntry({ source: "airbnb", summary: "Reserved (HMZXCVBN34)" })).toBe("HMZXCVBN34");
  });

  it("parses the code out of a real Airbnb iCal event description", () => {
    const [event] = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:1418fb94abcdef@airbnb.com",
        "SUMMARY:Reserved",
        "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de",
        ` tails/HM8F9S4DWC\\nPhone Number (Last 4 Digits): 1234`,
        "DTSTART;VALUE=DATE:20261009",
        "DTEND;VALUE=DATE:20261013",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const code = parseReservationDescription(event.description).reservationCode;
    expect(code).toBe("HM8F9S4DWC");
    expect(reservationCodeForEntry({ source: "airbnb", summary: event.summary, reservationCode: code })).toBe("HM8F9S4DWC");
  });

  it("never returns the long calendar uid or a hostile code", () => {
    expect(reservationCodeForEntry({ source: "airbnb", summary: "Reserved", reservationCode: "1418fb94@airbnb.com" })).toBeNull();
    expect(reservationCodeForEntry({ source: "airbnb", summary: "Reserved" })).toBeNull();
    expect(reservationCodeForEntry({ source: "airbnb", summary: "x", reservationUrl: "https://evil.example/hosting/reservations/details/HMABCDEFGH" })).toBeNull();
  });
});

describe("airbnbOpenUrlForEntry", () => {
  it("builds the Airbnb link from the code, for Airbnb stays only", () => {
    expect(airbnbOpenUrlForEntry({ source: "airbnb", summary: "Reserved", reservationCode: "HM8F9S4DWC" })).toBe(`${URL_PREFIX}HM8F9S4DWC`);
    expect(airbnbOpenUrlForEntry({ source: "booking_com", summary: "Reserved", reservationCode: "HM8F9S4DWC" })).toBeNull();
    expect(airbnbOpenUrlForEntry({ source: "airbnb", summary: "Airbnb (Not available)" })).toBeNull();
  });
});
