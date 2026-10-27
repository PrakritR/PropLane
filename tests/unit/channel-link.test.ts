import { describe, expect, it } from "vitest";

import {
  autoLinkForStay,
  hmCodeFromText,
  normalizeChannelLink,
  reservationOptionsForStay,
  resolveChannelLinks,
  stayDetailsWithLink,
  stayDetailsWithSource,
  withLinkedChannelStays,
  withoutLinkedReservation,
  type LinkableRange,
} from "@/lib/channel-calendar/channel-link";
import { calendarStatus, calendarStatusClass } from "@/lib/channel-calendar/bookings-calendar-view";
import { bookingVisualSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { occupancyForDay, withoutChannelStaysCoveredByResidents } from "@/lib/occupancy/snapshot";
import { bookingEntryNamedLabel } from "@/lib/channel-calendar/booking-guest-label";

const P = "prop-1";

function channel(over: Partial<PropertyBookingEntry> & { start: string; end: string }): PropertyBookingEntry {
  return {
    source: "airbnb",
    propertyId: P,
    propertyLabel: "4709A",
    roomId: "r7",
    roomLabel: "Room 7",
    summary: "Reserved",
    sourceUid: `uid-${over.start}`,
    connectionId: "conn-r7",
    ...over,
  };
}

function native(over: Partial<PropertyBookingEntry> & { blockId: string; start: string; end: string }): PropertyBookingEntry {
  return {
    source: "block",
    propertyId: P,
    propertyLabel: "4709A",
    roomId: "r7",
    roomLabel: "Room 7",
    summary: "Kumaran",
    residentName: "Kumaran",
    bookingStatus: "confirmed",
    reason: "",
    ...over,
  };
}

const range = (over: Partial<LinkableRange> & { start: string; end: string }): LinkableRange => ({
  provider: "airbnb",
  propertyId: P,
  roomId: "r7",
  summary: "Reserved",
  ...over,
});

describe("channel link: normalize and codes", () => {
  it("keeps only a provider plus a code or uid", () => {
    expect(normalizeChannelLink({ provider: "airbnb", reservationCode: "hmrrn4xtz8" })).toEqual({ provider: "airbnb", reservationCode: "HMRRN4XTZ8" });
    expect(normalizeChannelLink({ provider: "booking_com", sourceUid: " 123@booking " })).toEqual({ provider: "booking_com", sourceUid: "123@booking" });
    expect(normalizeChannelLink({ provider: "vrbo", sourceUid: "x" })).toBeUndefined();
    expect(normalizeChannelLink({ provider: "airbnb", reservationCode: "nope" })).toBeUndefined();
    expect(normalizeChannelLink({ provider: "booking_com", reservationCode: "HMRRN4XTZ8" })).toBeUndefined();
    expect(normalizeChannelLink("airbnb")).toBeUndefined();
  });

  it("reads an HM code out of free text", () => {
    expect(hmCodeFromText("Airbnb HMRRN4XTZ8 - paid")).toBe("HMRRN4XTZ8");
    expect(hmCodeFromText(null, "ref hmabc12345")).toBe("HMABC12345");
    expect(hmCodeFromText("Reserved · Airbnb")).toBeNull();
  });
});

describe("auto-link", () => {
  it("links by the HM code in the notes", () => {
    const hit = autoLinkForStay(
      { propertyId: P, roomId: "r7", start: "2026-10-01", end: "2026-10-30", reason: "Airbnb HMRRN4XTZ8" },
      [range({ start: "2026-10-03", end: "2026-11-02", reservationCode: "HMRRN4XTZ8", sourceUid: "u1" }), range({ start: "2026-12-01", end: "2026-12-05", reservationCode: "HMOTHER123", sourceUid: "u2" })],
    );
    expect(hit?.link).toEqual({ provider: "airbnb", reservationCode: "HMRRN4XTZ8", sourceUid: "u1" });
  });

  it("links by room and dates within a night when there is no code", () => {
    const hit = autoLinkForStay(
      { propertyId: P, roomId: "r7", start: "2026-10-03", end: "2026-11-01", reason: "Reserved · Airbnb" },
      [range({ start: "2026-10-04", end: "2026-11-02", sourceUid: "u1" }), range({ roomId: "r8", start: "2026-10-03", end: "2026-11-01", sourceUid: "other-room" })],
    );
    expect(hit?.range.sourceUid).toBe("u1");
  });

  it("does not link when check-in is two nights off", () => {
    expect(autoLinkForStay({ propertyId: P, roomId: "r7", start: "2026-10-03", end: "2026-11-01" }, [range({ start: "2026-10-05", end: "2026-11-01", sourceUid: "u1" })])).toBeNull();
  });

  it("ambiguous means no link: two reservations fit the dates", () => {
    expect(
      autoLinkForStay({ propertyId: P, roomId: "r7", start: "2026-10-03", end: "2026-11-01" }, [
        range({ start: "2026-10-03", end: "2026-11-01", sourceUid: "a" }),
        range({ start: "2026-10-04", end: "2026-11-01", sourceUid: "b" }),
      ]),
    ).toBeNull();
  });

  it("ambiguous means no link: the same code twice", () => {
    expect(
      autoLinkForStay({ propertyId: P, roomId: "", start: "2026-10-03", end: "2026-11-01", reason: "HMRRN4XTZ8" }, [
        range({ start: "2026-10-03", end: "2026-11-01", reservationCode: "HMRRN4XTZ8", sourceUid: "a" }),
        range({ roomId: "r8", start: "2026-10-03", end: "2026-11-01", reservationCode: "HMRRN4XTZ8", sourceUid: "b" }),
      ]),
    ).toBeNull();
  });

  it("never auto-links to a host block", () => {
    expect(
      autoLinkForStay({ propertyId: P, roomId: "r7", start: "2026-10-03", end: "2026-11-01" }, [range({ start: "2026-10-03", end: "2026-11-01", sourceUid: "a", summary: "Airbnb (Not available)" })]),
    ).toBeNull();
  });

  it("a whole-home stay can only be linked by its code, never by dates", () => {
    expect(autoLinkForStay({ propertyId: P, roomId: "", start: "2026-10-03", end: "2026-11-01" }, [range({ start: "2026-10-03", end: "2026-11-01", sourceUid: "a" })])).toBeNull();
  });
});

describe("a linked stay covers its channel copy", () => {
  const copy = channel({ start: "2026-10-03", end: "2026-11-02", sourceUid: "u1", reservationCode: "HMRRN4XTZ8" });
  const decoy = channel({ start: "2026-11-10", end: "2026-11-12", sourceUid: "u2", reservationCode: "HMOTHER123" });

  it("explicit link: the channel copy is dropped from the calendar list and the stay draws as the channel", () => {
    const stay = native({ blockId: "b1", start: "2026-10-03", end: "2026-11-02", stayDetails: { channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" } } });
    const entries = withLinkedChannelStays([copy, decoy, stay]);
    const linked = entries.find((entry) => entry.blockId === "b1")!;
    expect(linked.channelLink).toEqual({ provider: "airbnb", reservationCode: "HMRRN4XTZ8" });
    expect(bookingVisualSource(linked)).toBe("airbnb");
    expect(calendarStatus(linked, "2026-10-26")).toBe("Airbnb");
    expect(calendarStatusClass(calendarStatus(linked, "2026-10-26"))).toBe(calendarStatusClass("Airbnb"));
    // The copy stays in `entries` (record page, payouts) but names the guest; the calendar list loses it.
    const shownCopy = entries.find((entry) => entry.sourceUid === "u1")!;
    expect(shownCopy.guestName).toBe("Kumaran");
    expect(bookingEntryNamedLabel(shownCopy)).toBe("Kumaran");
    const calendar = withoutChannelStaysCoveredByResidents(entries);
    expect(calendar.map((entry) => entry.sourceUid ?? entry.blockId).sort()).toEqual(["b1", "u2"]);
  });

  it("auto-link by HM code in the notes covers the copy with nothing stored", () => {
    const stay = native({ blockId: "b1", start: "2026-10-01", end: "2026-10-30", reason: "Airbnb HMRRN4XTZ8" });
    const resolved = resolveChannelLinks([copy, decoy, stay]);
    expect(resolved.links.get("b1")).toMatchObject({ provider: "airbnb", reservationCode: "HMRRN4XTZ8" });
    expect(resolved.derived.has("b1")).toBe(true);
    expect(withoutChannelStaysCoveredByResidents([copy, decoy, stay]).map((entry) => entry.sourceUid ?? entry.blockId).sort()).toEqual(["b1", "u2"]);
  });

  it("two stays claiming one reservation: neither is linked, both reservations stay", () => {
    const a = native({ blockId: "a", start: "2026-10-03", end: "2026-11-02" });
    const b = native({ blockId: "b", start: "2026-10-04", end: "2026-11-02", summary: "Vaibhav", residentName: "Vaibhav" });
    expect(resolveChannelLinks([copy, a, b]).links.size).toBe(0);
    expect(withoutChannelStaysCoveredByResidents([copy, a, b])).toHaveLength(3);
  });

  it("an explicit link wins the reservation before an auto-link can take it", () => {
    const explicit = native({ blockId: "x", start: "2026-12-20", end: "2026-12-25", stayDetails: { channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" } } });
    const lookalike = native({ blockId: "y", start: "2026-10-03", end: "2026-11-02", summary: "Vaibhav", residentName: "Vaibhav" });
    const resolved = resolveChannelLinks([copy, explicit, lookalike]);
    expect(resolved.links.get("x")).toBeDefined();
    expect(resolved.links.has("y")).toBe(false);
  });

  it("a cancelled stay links nothing and covers nothing", () => {
    const stay = native({ blockId: "b1", start: "2026-10-03", end: "2026-11-02", bookingStatus: "cancelled", stayDetails: { channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" } } });
    expect(resolveChannelLinks([copy, stay]).covered.size).toBe(0);
  });

  it("a stored link still marks its stay after the reservation left the feed", () => {
    const stay = native({ blockId: "b1", start: "2026-10-03", end: "2026-11-02", stayDetails: { channelLink: { provider: "airbnb", reservationCode: "HMGONE0000" } } });
    expect(withLinkedChannelStays([stay])[0]!.channelLink?.provider).toBe("airbnb");
  });

  it("occupancy counts a linked stay and its copy as one bed", () => {
    const stay = native({ blockId: "b1", start: "2026-10-03", end: "2026-11-02", stayDetails: { channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" } } });
    const cell = occupancyForDay([copy, stay], "2026-10-10", [P], { bedsTotal: () => 2, roomCapacity: () => 1 });
    expect(cell.occupied).toBe(1);
    expect(cell.inHouse).toBe(1);
  });

  it("the sheet's conflict pool loses only the reservation the stay is", () => {
    expect(withoutLinkedReservation([copy, decoy], { provider: "airbnb", reservationCode: "HMRRN4XTZ8" }).map((entry) => entry.sourceUid)).toEqual(["u2"]);
    expect(withoutLinkedReservation([copy, decoy], undefined)).toHaveLength(2);
  });
});

describe("the reservation picker", () => {
  it("lists that room's reservations, closest dates first, never a host block", () => {
    const near = channel({ start: "2026-10-03", end: "2026-11-02", sourceUid: "near", reservationCode: "HMNEAR0001" });
    const far = channel({ start: "2026-12-03", end: "2026-12-09", sourceUid: "far", reservationCode: "HMFAR00001" });
    const block = channel({ start: "2026-10-03", end: "2026-11-02", sourceUid: "blk", summary: "Airbnb (Not available)" });
    const elsewhere = channel({ roomId: "r8", start: "2026-10-03", end: "2026-11-02", sourceUid: "r8" });
    const booking = channel({ source: "booking_com", start: "2026-10-03", end: "2026-11-02", sourceUid: "bk" });
    const options = reservationOptionsForStay([far, near, block, elsewhere, booking], { provider: "airbnb", propertyId: P, roomId: "r7", start: "2026-10-03", end: "2026-11-02" });
    expect(options.map((entry) => entry.sourceUid)).toEqual(["near", "far"]);
  });

  it("picking Source drops a link to the other channel", () => {
    const next = stayDetailsWithSource({ source: "Airbnb", channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" } }, "Booking.com");
    expect(next.channelLink).toBeUndefined();
    expect(stayDetailsWithSource({ source: "Direct", channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" } }, "Airbnb").channelLink).toBeDefined();
  });

  it("an auto-linked stay opens with the link and a Source that says its channel", () => {
    expect(stayDetailsWithLink({ source: "Direct" }, { provider: "airbnb", reservationCode: "HMRRN4XTZ8" })).toEqual({ source: "Airbnb", channelLink: { provider: "airbnb", reservationCode: "HMRRN4XTZ8" } });
    expect(stayDetailsWithLink({ source: "Tenant" }, { provider: "airbnb", reservationCode: "HMRRN4XTZ8" }).source).toBe("Tenant");
  });
});

describe("PadSplit and Booking.com colours", () => {
  it("a PadSplit-source stay is PadSplit; the three channel colours differ", () => {
    const stay = native({ blockId: "p1", start: "2026-10-03", end: "2026-10-09", stayDetails: { source: "PadSplit" } });
    expect(calendarStatus(stay, "2026-10-26")).toBe("PadSplit");
    const classes = new Set([calendarStatusClass("Airbnb"), calendarStatusClass("Booking.com"), calendarStatusClass("PadSplit")]);
    expect(classes.size).toBe(3);
  });
});
