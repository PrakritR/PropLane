import { describe, expect, it } from "vitest";
import {
  channelGuestKeyAddress,
  channelSiteOfAddress,
  isChannelRelayAddress,
  parseChannelGuestMessage,
} from "@/lib/inbound-email/channel-senders";
import { parseAirbnbEmail, parseAirbnbGuestMessage } from "@/lib/inbound-email/airbnb-parser";
import { inboundSenderAuthenticated, replyToFromHeaders } from "@/lib/inbound-email/inbound-sender-authentication";
import { matchChannelListing, type ChannelRoomCandidate } from "@/lib/channel-calendar/channel-listing-match";
import {
  AIRBNB_MESSAGE,
  ALL_CHANNEL_FIXTURES,
  BOOKING_MESSAGE,
  PADSPLIT_MESSAGE,
  SPAREROOM_MESSAGE,
} from "../fixtures/channel-inbox-emails";

describe("site recognition is by the sender's real domain", () => {
  it("knows each site and its subdomains", () => {
    expect(channelSiteOfAddress("automated@airbnb.com")).toBe("airbnb");
    expect(channelSiteOfAddress("x@reply.airbnb.com")).toBe("airbnb");
    expect(channelSiteOfAddress("noreply@booking.com")).toBe("booking_com");
    expect(channelSiteOfAddress("no-reply@padsplit.com")).toBe("padsplit");
    expect(channelSiteOfAddress("noreply@spareroom.com")).toBe("spareroom");
    expect(channelSiteOfAddress("noreply@spareroom.co.uk")).toBe("spareroom");
  });

  it("never takes a look-alike domain for a site", () => {
    expect(channelSiteOfAddress("a@airbnb.com.evil.test")).toBeNull();
    expect(channelSiteOfAddress("a@notairbnb.com")).toBeNull();
    expect(channelSiteOfAddress("a@booking.com.example.org")).toBeNull();
    expect(channelSiteOfAddress("someone@gmail.com")).toBeNull();
  });

  it("trusts a relay address only on the site's own domain", () => {
    expect(isChannelRelayAddress("airbnb", "k3f9a1c2d4@reply.airbnb.com")).toBe(true);
    expect(isChannelRelayAddress("airbnb", "k3f9a1c2d4@evil.test")).toBe(false);
    expect(isChannelRelayAddress("booking_com", "x@guest.booking.com")).toBe(true);
    expect(isChannelRelayAddress("booking_com", "x@guest.airbnb.com")).toBe(false);
    expect(isChannelRelayAddress("padsplit", null)).toBe(false);
  });
});

describe("each site's message email is read into guest, message, listing and relay", () => {
  for (const fixture of ALL_CHANNEL_FIXTURES) {
    it(`${fixture.fromEmail}`, () => {
      const parsed = parseChannelGuestMessage({ fromEmail: fixture.fromEmail, subject: fixture.subject, text: fixture.text, replyTo: fixture.replyTo });
      expect(parsed).not.toBeNull();
      expect(parsed!.guestName).toBe(fixture.expect.guestName);
      expect(parsed!.messageText).toContain(fixture.expect.messageIncludes);
      expect(parsed!.listingTitle ?? "").toContain(fixture.expect.listingTitleIncludes);
      expect(parsed!.reservationCode).toBe(fixture.expect.reservationCode);
      expect(parsed!.replyAddress).toBe(fixture.replyTo);
      // The footer, the site's links and the reply boilerplate are not part of the guest's words.
      expect(parsed!.messageText).not.toMatch(/https?:\/\//);
      expect(parsed!.messageText).not.toMatch(/Reply to this|Airbnb, Inc|Booking\.com B\.V|PadSplit, Inc|SpareRoom Inc/i);
    });
  }

  it("PadSplit without a relay address has none: the reply is then held, never sent", () => {
    const parsed = parseChannelGuestMessage({ fromEmail: PADSPLIT_MESSAGE.fromEmail, subject: PADSPLIT_MESSAGE.subject, text: PADSPLIT_MESSAGE.text, replyTo: null });
    expect(parsed?.replyAddress).toBeNull();
  });

  it("drops a Reply-To that is not on the site's domain", () => {
    const parsed = parseChannelGuestMessage({ fromEmail: BOOKING_MESSAGE.fromEmail, subject: BOOKING_MESSAGE.subject, text: BOOKING_MESSAGE.text, replyTo: "attacker@evil.test" });
    expect(parsed?.guestName).toBe("Maria L.");
    expect(parsed?.replyAddress).toBeNull();
  });

  it("returns null for a site mail that is not a guest message", () => {
    expect(parseChannelGuestMessage({ fromEmail: "noreply@booking.com", subject: "Your payout is on the way", text: "Payout of $120.00 sent." })).toBeNull();
    expect(parseChannelGuestMessage({ fromEmail: "someone@gmail.com", subject: AIRBNB_MESSAGE.subject, text: AIRBNB_MESSAGE.text })).toBeNull();
  });

  it("an Airbnb message is a message kind and never a booking or payout", () => {
    const message = parseAirbnbGuestMessage({ subject: AIRBNB_MESSAGE.subject, text: AIRBNB_MESSAGE.text });
    expect(message?.kind).toBe("message");
    expect(parseAirbnbEmail({ subject: AIRBNB_MESSAGE.subject, text: AIRBNB_MESSAGE.text })).toBeNull();
    // ...and a booking confirmation is not read as a message.
    expect(parseAirbnbGuestMessage({ subject: "Reservation confirmed - Jose arrives Nov 12", text: "Jose arrives Nov 12\nCheck-in Nov 12\nCheck-out Nov 19\nHMTESTCODE1" })).toBeNull();
  });
});

describe("one conversation per guest per site", () => {
  it("the same guest always gets the same key, another guest or site another", () => {
    const a = channelGuestKeyAddress("airbnb", "Jose Alaniz");
    expect(channelGuestKeyAddress("airbnb", "  jose   alaniz ")).toBe(a);
    expect(channelGuestKeyAddress("booking_com", "Jose Alaniz")).not.toBe(a);
    expect(channelGuestKeyAddress("airbnb", "Jose Alvarez")).not.toBe(a);
    expect(a.endsWith(".invalid")).toBe(true);
  });
});

describe("sender authentication is the site's signature, not the From line", () => {
  const headers = (value: string) => ({ "authentication-results": [value] });
  it("accepts dkim=pass aligned to the site, including a forwarded copy that kept the signature", () => {
    expect(inboundSenderAuthenticated(headers("mx.resend.com; dkim=pass header.d=airbnb.com"), "automated@airbnb.com")).toBe(true);
  });
  it("refuses a forged From with no pass, or a pass for another domain", () => {
    expect(inboundSenderAuthenticated(headers("mx.resend.com; dkim=fail header.d=airbnb.com"), "automated@airbnb.com")).toBe(false);
    expect(inboundSenderAuthenticated(headers("mx.resend.com; dkim=pass header.d=evil.test"), "automated@airbnb.com")).toBe(false);
    expect(inboundSenderAuthenticated(undefined, "automated@airbnb.com")).toBe(false);
  });
  it("reads the Reply-To header", () => {
    expect(replyToFromHeaders({ "Reply-To": ["Airbnb <K3F9@reply.airbnb.com>"] })).toBe("k3f9@reply.airbnb.com");
    expect(replyToFromHeaders({})).toBeNull();
  });
});

describe("a listing title maps to the right house and room through the channel connections", () => {
  const room = (propertyId: string, propertyLabel: string, roomId: string, roomLabel: string, extra: Partial<ChannelRoomCandidate> = {}): ChannelRoomCandidate => ({
    propertyId, propertyLabel, roomId, roomLabel, reservationCodes: [], ...extra,
  });
  const candidates = [
    room("p5257", "5257 Brooklyn Ave", "r6", "Room 6", { reservationCodes: ["HMTESTCODE1"] }),
    room("p5257", "5257 Brooklyn Ave", "r66", "Room 66"),
    room("p5259", "5259 Brooklyn Ave", "r1", "Room 1"),
    room("p4709", "4709A 8th Ave", "r9", "Room 9"),
    room("p4709", "4709A 8th Ave", "r5", "Room 5", { adTitle: "Private locked room near University of Washington" }),
  ];

  it("Airbnb: by the listing title, exactly Room 6 and not Room 66", () => {
    const match = matchChannelListing({ site: "airbnb", listingTitle: "Private room near UW - 5257 Brooklyn Ave Room 6", reservationCode: null }, candidates);
    expect(match).toMatchObject({ propertyId: "p5257", roomId: "r6", via: "listing_title" });
  });

  it("Airbnb: the reservation code outranks the title", () => {
    const match = matchChannelListing({ site: "airbnb", listingTitle: "something unrelated", reservationCode: "HMTESTCODE1" }, candidates);
    expect(match).toMatchObject({ propertyId: "p5257", roomId: "r6", via: "reservation_code" });
  });

  it("Booking.com: property line with the room", () => {
    const match = matchChannelListing({ site: "booking_com", listingTitle: "4709A 8th Ave - Room 9", reservationCode: "4012345678" }, candidates);
    expect(match).toMatchObject({ propertyId: "p4709", roomId: "r9" });
  });

  it("PadSplit: the neighbouring house is not confused", () => {
    const match = matchChannelListing({ site: "padsplit", listingTitle: "5259 Brooklyn Ave - Room 1", reservationCode: null }, candidates);
    expect(match).toMatchObject({ propertyId: "p5259", roomId: "r1" });
  });

  it("SpareRoom: the recorded ad title names the house, the room stays unnamed when two share it", () => {
    const match = matchChannelListing({ site: "spareroom", listingTitle: "Private locked room near University of Washington", reservationCode: null }, candidates);
    expect(match?.propertyId).toBe("p4709");
  });

  it("answers nothing rather than guessing across houses", () => {
    expect(matchChannelListing({ site: "airbnb", listingTitle: "Brooklyn Ave Room 1", reservationCode: null }, candidates)).toBeNull();
    expect(matchChannelListing({ site: "airbnb", listingTitle: null, reservationCode: null }, candidates)).toBeNull();
  });
});

describe("fixtures stay synthetic", () => {
  it("carries no real-looking contact details", () => {
    for (const fixture of [AIRBNB_MESSAGE, BOOKING_MESSAGE, PADSPLIT_MESSAGE, SPAREROOM_MESSAGE]) {
      expect(fixture.text).not.toMatch(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/);
    }
  });
});
