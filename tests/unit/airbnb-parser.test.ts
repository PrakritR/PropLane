import { describe, expect, it } from "vitest";
import { isAirbnbSenderAddress, parseAirbnbEmail } from "@/lib/inbound-email/airbnb-parser";

// SYNTHETIC fixtures: realistic in shape, written for this test, not copied from real Airbnb mail.
const BOOKING_TEXT = `Reservation confirmed - Juan arrives Oct 13

Juan Angel is arriving soon.

4709A 8th Ave NE - Room 9
Check-in
Mon, Oct 13
4:00 PM
Checkout
Thu, Oct 16
11:00 AM

3 nights
Confirmation code
HMHW5SHXRB

You earn $412.00
`;

const PAYOUT_TEXT = `We've sent your payout of $412.00

Payout for Juan's stay
Reservation HMHW5SHXRB
Check-in Oct 13, 2026
Checkout Oct 16, 2026

Total payout $412.00
It should arrive in 1-3 business days.
`;

describe("parseAirbnbEmail", () => {
  it("reads a reservation-confirmed mail", () => {
    const parsed = parseAirbnbEmail({ subject: "Reservation confirmed - Juan arrives Oct 13", text: BOOKING_TEXT, receivedAt: "2026-10-09T18:00:00Z" });
    expect(parsed).toEqual({
      kind: "booking",
      confirmationCode: "HMHW5SHXRB",
      guestFirstName: "Juan",
      checkIn: "2026-10-13",
      checkOut: "2026-10-16",
      nights: 3,
    });
  });

  it("reads a payout mail", () => {
    const parsed = parseAirbnbEmail({ subject: "Your payout is on the way", text: PAYOUT_TEXT, receivedAt: "2026-10-17T09:00:00Z" });
    expect(parsed).toMatchObject({ kind: "payout", confirmationCode: "HMHW5SHXRB", payoutCents: 41200, checkIn: "2026-10-13", checkOut: "2026-10-16", guestFirstName: "Juan" });
  });

  it("rolls a yearless stay that is months ahead into next year", () => {
    const parsed = parseAirbnbEmail({ subject: "New booking confirmed! Maria arrives Jan 4", text: "Check-in\nSun, Jan 4\nCheckout\nWed, Jan 7\nHMABCDEFGH2\n", receivedAt: "2026-10-09T18:00:00Z" });
    expect(parsed?.checkIn).toBe("2027-01-04");
    expect(parsed?.checkOut).toBe("2027-01-07");
  });

  it("returns null when unsure", () => {
    expect(parseAirbnbEmail({ subject: "Reservation confirmed", text: "No code here. Check-in Oct 13 Checkout Oct 16", receivedAt: "2026-10-09T00:00:00Z" })).toBeNull();
    expect(parseAirbnbEmail({ subject: "Tips for hosts", text: "Read our guide. HMHW5SHXRB", receivedAt: "2026-10-09T00:00:00Z" })).toBeNull();
    expect(parseAirbnbEmail({ subject: "Payout sent", text: "Your payout was sent. HMHW5SHXRB", receivedAt: "2026-10-09T00:00:00Z" })).toBeNull();
  });
});

describe("isAirbnbSenderAddress", () => {
  it("accepts airbnb.com and subdomains only", () => {
    expect(isAirbnbSenderAddress("automated@airbnb.com")).toBe(true);
    expect(isAirbnbSenderAddress("x@mail.airbnb.com")).toBe(true);
    expect(isAirbnbSenderAddress("x@airbnb.com.evil.test")).toBe(false);
    expect(isAirbnbSenderAddress("x@notairbnb.com")).toBe(false);
  });
});
