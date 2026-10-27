import { describe, expect, it } from "vitest";
import {
  CHANNEL_CONFIRM_LATER_REPLY,
  channelHoldReason,
  channelReplyViolations,
  enforceCheckedAvailability,
} from "@/lib/agent/channel-reply-policy";

describe("what is held for the manager", () => {
  it.each([
    ["Can I get a refund for the first night?", "money"],
    ["I was charged twice, please fix", "money"],
    ["Can you do a discount if I stay a month?", "money"],
    ["I need to cancel my reservation", "cancellation"],
    ["Can we change my dates to December?", "cancellation"],
    ["The room was dirty and the heater is broken, this is unacceptable", "complaint"],
    ["I saw bed bugs and I will leave a review", "complaint"],
  ])("%s -> %s", (message, reason) => {
    expect(channelHoldReason(message)).toBe(reason);
  });

  it.each([
    "Is there parking?",
    "Is early check-in possible? I land around 10am.",
    "When can I move in?",
    "Which rooms are close to UW and when can I see one?",
    "Is the room furnished and is wifi included?",
  ])("answers routine questions on its own: %s", (message) => {
    expect(channelHoldReason(message)).toBeNull();
  });
});

describe("a reply with contact details is held on Airbnb and Booking.com", () => {
  for (const site of ["airbnb", "booking_com"] as const) {
    it(`${site}: URL, phone and email all violate`, () => {
      expect(channelReplyViolations(site, "Sure! See https://proplane.ai/rent/abc for photos.")).toContain("link");
      expect(channelReplyViolations(site, "See proplane.ai for the details.")).toContain("link");
      expect(channelReplyViolations(site, "Text us at (206) 678-1909 anytime.")).toContain("phone");
      expect(channelReplyViolations(site, "Call +1 206 678 1909 whenever.")).toContain("phone");
      expect(channelReplyViolations(site, "Email me at host@proplane.ai please.")).toContain("email");
      expect(channelReplyViolations(site, "Happy to take payment on Venmo instead.")).toContain("off_platform");
    });

    it(`${site}: a clean reply with dates and prices passes`, () => {
      expect(channelReplyViolations(site, "Room 6 is free from November 1, 2026 at $1,150 a month. Check-in 3-6pm; 2026-11-01 works.")).toEqual([]);
    });

    it(`${site}: even the PropLane line is not allowed`, () => {
      expect(channelReplyViolations(site, "Text (206) 678-1909.", { allowedPhoneDigits: "2066781909" })).toContain("phone");
    });
  }

  it("PadSplit and SpareRoom may carry the listing link and the PropLane line, nothing else", () => {
    for (const site of ["padsplit", "spareroom"] as const) {
      const options = { allowedPhoneDigits: "(206) 678-1909" };
      expect(channelReplyViolations(site, "Details: https://proplane.ai/rent/abc, or text (206) 678-1909.", options)).toEqual([]);
      expect(channelReplyViolations(site, "Text (425) 555-0100 instead.", options)).toContain("phone");
      expect(channelReplyViolations(site, "Write to host@proplane.ai", options)).toContain("email");
      expect(channelReplyViolations(site, "Pay me on Zelle.", options)).toContain("off_platform");
    }
  });
});

describe("availability is only ever stated from a checked read", () => {
  const claim = "Room 6 is available from November 1.";
  const verifiedRoom6 = { tool: "check_room_availability", output: { found: true, ok: true, rooms: [{ roomId: "r6", roomLabel: "Room 6", available: true }] } };
  const unverifiedRoom6 = { tool: "check_room_availability", output: { found: true, ok: true, rooms: [{ roomId: "r6", roomLabel: "Room 6", available: null }] } };

  it("a claim with no availability read is replaced by the confirm-later text", () => {
    expect(enforceCheckedAvailability({ reply: claim, toolEvidence: [] })).toEqual({ reply: CHANNEL_CONFIRM_LATER_REPLY, replaced: true });
  });

  it("a claim after only FAILED reads is replaced", () => {
    const result = enforceCheckedAvailability({
      reply: claim,
      toolEvidence: [
        { tool: "check_room_availability", output: { found: true, ok: false, error: "listing_unreadable" } },
        { tool: "get_listing_details", output: { found: false } },
      ],
    });
    expect(result).toEqual({ reply: CHANNEL_CONFIRM_LATER_REPLY, replaced: true });
    expect(result.reply).not.toMatch(/\bis available\b/i);
  });

  it("a read that succeeded but verified nothing is not evidence", () => {
    expect(enforceCheckedAvailability({ reply: claim, toolEvidence: [unverifiedRoom6] })).toEqual({ reply: CHANNEL_CONFIRM_LATER_REPLY, replaced: true });
  });

  it("naming a room the turn could not verify is replaced, even beside a verified one", () => {
    const listed = {
      tool: "list_live_listings",
      output: {
        listings: [
          { title: "Alder St", rooms: [{ name: "Room 2", currentAvailabilityVerified: true, freeNow: true }] },
          { title: "Brooklyn Ave", rooms: [{ name: "Room 6", currentAvailabilityVerified: false, availabilityNote: "Not checked in this list" }] },
        ],
      },
    };
    expect(enforceCheckedAvailability({ reply: claim, toolEvidence: [listed] })).toEqual({ reply: CHANNEL_CONFIRM_LATER_REPLY, replaced: true });
    expect(enforceCheckedAvailability({ reply: "Room 2 is available from November 1.", toolEvidence: [listed] })).toEqual({
      reply: "Room 2 is available from November 1.",
      replaced: false,
    });
  });

  it("a claim backed by a verified checked read stands, and a non-claim is never touched", () => {
    expect(enforceCheckedAvailability({ reply: claim, toolEvidence: [verifiedRoom6] })).toEqual({ reply: claim, replaced: false });
    expect(enforceCheckedAvailability({ reply: "Parking is street only.", toolEvidence: [] })).toEqual({ reply: "Parking is street only.", replaced: false });
  });

  it("the confirm-later text itself makes no availability claim", () => {
    expect(enforceCheckedAvailability({ reply: CHANNEL_CONFIRM_LATER_REPLY, toolEvidence: [] }).replaced).toBe(false);
  });
});
