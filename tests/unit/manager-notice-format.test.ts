import { describe, expect, it } from "vitest";
import {
  digestSection,
  formatBookingNotice,
  formatInboundForward,
  formatLeadNotice,
  formatStayReminderLine,
  guestNoticeName,
  isClosedBlockLabel,
  isMenuAnswer,
  isRealGuestName,
  nightsBetween,
  stayDatesLabel,
} from "@/lib/manager-notice-format";
import { renderChannelBookingEvent, renderNativeBookingEvent } from "@/lib/channel-booking-events.server";
import { buildTeamNoticeLine } from "@/lib/team-notice-line";
import { bookingReminderHeadline } from "@/lib/reminders/subjects/bookings.server";
import { buildMorningDigestText } from "@/lib/one-number/ops-text";
import { managerReminderExternalText } from "@/lib/reminders/dispatch.server";

describe("guest naming", () => {
  it("a real name wins over a code; placeholders read as the channel's guest with the code beside it", () => {
    expect(guestNoticeName({ name: "Priya Nair", channel: "Airbnb", code: "HMMS4HRSEB" })).toBe("Priya Nair");
    expect(guestNoticeName({ name: "CLOSED - Not available", channel: "Booking.com" })).toBe("Booking.com guest");
    expect(guestNoticeName({ name: "HMMS4HRSEB", channel: "Airbnb" })).toBe("Airbnb guest HMMS4HRSEB");
    expect(isRealGuestName("Reserved")).toBe(false);
    expect(isRealGuestName("Maya Rao")).toBe(true);
  });
  it("closed blocks are recognised", () => {
    expect(isClosedBlockLabel("CLOSED - Not available")).toBe(false); // a privacy-stripped Booking.com reservation
    expect(isClosedBlockLabel("Blocked")).toBe(true);
    expect(isClosedBlockLabel("Priya Nair")).toBe(false);
  });
});

describe("booking notices (before: 'New Booking.com booking, Ambika Mago.')", () => {
  it("names the guest, place, nights, channel and code, never the owner", () => {
    const n = formatBookingNotice({
      created: true,
      guestName: "Priya Nair",
      channel: "Airbnb",
      code: "HMMS4HRSEB",
      house: "5257 Brooklyn Ave",
      room: "Room 6",
      checkIn: "2026-11-14",
      checkOutExclusive: "2026-11-17",
      url: "https://x.test/b",
    });
    expect(n.sms).toBe("New booking: Priya Nair, 5257 Brooklyn Ave · Room 6, Nov 14–17 (3 nights), Airbnb HMMS4HRSEB.\nhttps://x.test/b");
    expect(n.sms).not.toContain("Ambika");
  });
  it("cancelled + unnamed channel guest keeps the code once", () => {
    const n = formatBookingNotice({ created: false, guestName: "CLOSED - Not available", channel: "Booking.com", code: "", house: "4709A 8th Ave", room: "Room 8", checkIn: "2026-11-14", checkOutExclusive: "2026-11-16" });
    expect(n.sms).toBe("Booking cancelled: Booking.com guest, 4709A 8th Ave · Room 8, Nov 14–16 (2 nights).");
  });
  it("channel and native renderers use it", () => {
    const c = renderChannelBookingEvent("channel_booking_created", { provider: "booking_com", propertyLabel: "4709A 8th Ave", roomLabel: "Room 8", start: "2026-11-14", end: "2026-11-15", guestLabel: "Booking.com guest" });
    expect(c.text).toContain("Booking.com guest");
    expect(c.text).toContain("2 nights");
    const n = renderNativeBookingEvent("booking_created", { propertyLabel: "5259", roomLabel: "Room 2", guestName: "Sam Lee", checkIn: "2026-11-14", checkOut: "2026-11-16" });
    expect(n.text).toContain("Sam Lee");
  });
  it("Team chat line: guest first, no owner, link last", () => {
    const line = buildTeamNoticeLine({ domain: "channel_booking", event: "channel_booking_created", subject: "Priya Nair", place: "5257 Brooklyn Ave · Room 6", extra: ["Nov 14–17 (3 nights)", "Airbnb"], url: "https://x.test/b" });
    expect(line).toBe("Booking created: Priya Nair, 5257 Brooklyn Ave, Room 6, Nov 14–17 (3 nights), Airbnb. https://x.test/b");
    expect(buildTeamNoticeLine({ domain: "channel_booking", event: "booking_cancelled", subject: "Sam" })).toBe("Booking cancelled: Sam.");
  });
});

describe("stay reminders", () => {
  it("check-out shows the guest name, not the raw code, and keeps the code beside the channel", () => {
    const line = bookingReminderHeadline("check_out", { guestName: "Priya Nair", checkInKey: "2026-11-10", checkOutKey: "2026-11-14", reservationCode: "HMMS4HRSEB", channel: "Airbnb" }, { property: "5257 Brooklyn Ave", room: "Room 6" });
    expect(line).toBe("Check-out today · Priya Nair · 5257 Brooklyn Ave · Room 6 · Airbnb HMMS4HRSEB · room free from Nov 14");
  });
  it("check-in carries dates and nights", () => {
    expect(formatStayReminderLine({ kind: "check_in", guestName: "Sam Lee", house: "5259", room: "Room 2", checkIn: "2026-11-15", checkOutExclusive: "2026-11-18", channel: "PropLane" })).toBe("Check-in tomorrow · Sam Lee · 5259 · Room 2 · Nov 15–18 (3 nights) · PropLane");
  });
  it("external text ends on the record link instead of 'Open PropLane to review'", () => {
    const t = managerReminderExternalText({ headline: "Check-out today · Sam", subject: "x", url: "https://x.test/b" });
    expect(t).toBe("Check-out today · Sam\nhttps://x.test/b");
    expect(t).not.toContain("Open PropLane to review");
  });
});

describe("lead notice (before: 'New lead for 4709a 8th Ave: budget $1200, move-in 2026-11-14, 3 mo, University district')", () => {
  it("names the lead, source, asks, fitting rooms and next step", () => {
    const t = formatLeadNotice({
      phone: "+12065554812",
      source: "PropLane line text",
      house: "4709A 8th Ave",
      budgetMax: 1200,
      moveInDate: "2026-11-14",
      leaseMonths: 3,
      area: "University district",
      fitRooms: [{ room: "Room 3", rent: 1150, availability: "available now" }, { room: "Room 6", rent: 1190, availability: "available Dec 1" }],
      url: "https://x.test/inbox",
    });
    expect(t).toBe("New lead: New texter ...4812 (PropLane line text) for 4709A 8th Ave. Budget $1,200, move-in Nov 14, 3 mo, University district. Fits: Room 3 $1,150 now, Room 6 $1,190 Dec 1. Reply or book a tour: https://x.test/inbox");
  });
  it("says so when no room fits", () => {
    expect(formatLeadNotice({ name: "Maya Rao", phone: "+12065554812", house: "5259", fitRooms: [] })).toBe("New lead: Maya Rao (...4812) for 5259. No room here fits yet.");
  });
});

describe("inbound forward (before: 'Texter ...4812: 1')", () => {
  it("a menu answer carries the question it answered and the house", () => {
    expect(isMenuAnswer("1")).toBe(true);
    expect(isMenuAnswer("is it furnished?")).toBe(false);
    const t = formatInboundForward({ phone: "+12065554812", body: "1", house: "4709A 8th Ave", lastQuestion: "Which home? 1) 4709A 8th Ave 2) 5257 Brooklyn" });
    expect(t).toBe('New texter ...4812 about 4709A 8th Ave: 1 (answering: "Which home? 1) 4709A 8th Ave 2) 5257 Brooklyn")');
  });
  it("a real message stands alone; a known name replaces the placeholder", () => {
    expect(formatInboundForward({ name: "Maya Rao", phone: "+12065554812", body: "Can I tour Saturday?", lastQuestion: "q" })).toBe("Maya Rao (...4812): Can I tour Saturday?");
  });
});

describe("dates and digest", () => {
  it("nights and labels", () => {
    expect(nightsBetween("2026-11-14", "2026-11-17")).toBe(3);
    expect(stayDatesLabel("2026-11-29", "2026-12-02")).toBe("Nov 29–Dec 2 (3 nights)");
  });
  it("digest names a few people", () => {
    expect(digestSection("check-ins today", [{ name: "Priya N.", house: "5259", room: "R2", detail: "Airbnb" }, { name: "Sam" }], 1)).toBe("2 check-ins today: Priya N. (5259 R2, Airbnb) +1 more.");
    expect(buildMorningDigestText({ toursToday: 2, openServices: 0, rent: null, newLeads: 1, tours: [{ who: "Maya", time: "10:30 am" }, { who: "Jo", time: "2 pm" }] })).toBe("2 tours today (Maya 10:30 am, Jo 2 pm), 1 new lead.");
  });
});

describe("a privacy-stripped channel reservation is a guest, never a closed room", () => {
  it("keeps Booking.com's \"CLOSED - Not available\" stays and skips only real host blocks and manager-closed rooms", async () => {
    const { isClosedBlockLabel, guestNoticeName } = await import("@/lib/manager-notice-format");
    expect(isClosedBlockLabel("CLOSED - Not available")).toBe(false);
    expect(isClosedBlockLabel("closed - not available")).toBe(false);
    expect(isClosedBlockLabel("Not available")).toBe(true);
    expect(isClosedBlockLabel("Airbnb (Not available)")).toBe(true);
    expect(isClosedBlockLabel("Blocked")).toBe(true);
    expect(isClosedBlockLabel("Closed · painting")).toBe(true);
    expect(isClosedBlockLabel("Priya Nair")).toBe(false);
    expect(guestNoticeName({ name: "CLOSED - Not available", channel: "Booking.com" })).toBe("Booking.com guest");
  });
});
