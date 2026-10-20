import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  carryGuestStayFields,
  guestBookAction,
  guestBookActionLabel,
  guestBookSummaryLine,
  guestStayApprovedText,
  guestStayBucket,
  guestStayConfirmedText,
  guestStayDeclinedText,
  guestStayExpiredText,
  guestStayRequestedText,
  guestStayStatusLabel,
  holdExpiresInLabel,
  parseGuestStayBucket,
  shortStayHoldExpiresAt,
  shortStayQuickPicks,
  shortStayRangesOverlap,
  sortGuestStays,
  withGuestSignInPrompt,
  type GuestStay,
} from "@/lib/short-stay/guest-stays";
import { guestStayFromRecord, listGuestStays } from "@/lib/short-stay/guest-stays.server";
import { GUEST, PROPERTY, completedStay, seedShortStayDb } from "../helpers/short-stay-seed";

const stay = (over: Partial<GuestStay> = {}): GuestStay => ({
  id: "s", propertyId: "p", roomId: "r", propertyLabel: "Cedar Court", roomLabel: "Attic Nook",
  checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3, guests: 1, status: "confirmed", holdExpiresAt: null, total: 420, nightly: 140, canBookAgain: true, ...over,
});

describe("quick picks", () => {
  it("Tomorrow is one night, Next week is three nights seven days out", () => {
    const [tomorrow, nextWeek] = shortStayQuickPicks("2026-10-14");
    expect(tomorrow).toEqual({ id: "tomorrow-1", label: "Tomorrow · 1 night", checkIn: "2026-10-15", checkOut: "2026-10-16" });
    expect(nextWeek).toEqual({ id: "next-week-3", label: "Next week · 3 nights", checkIn: "2026-10-21", checkOut: "2026-10-24" });
  });

  it("overlap is by night: back to back is fine", () => {
    expect(shortStayRangesOverlap({ checkIn: "2026-10-15", checkOut: "2026-10-16" }, { checkIn: "2026-10-16", checkOut: "2026-10-18" })).toBe(false);
    expect(shortStayRangesOverlap({ checkIn: "2026-10-15", checkOut: "2026-10-17" }, { checkIn: "2026-10-16", checkOut: "2026-10-18" })).toBe(true);
  });
});

describe("Upcoming | Past and the row facts", () => {
  const today = "2026-10-14";
  it("splits on check-out and status", () => {
    expect(guestStayBucket(stay(), today)).toBe("upcoming");
    expect(guestStayBucket(stay({ status: "pending" }), today)).toBe("upcoming");
    expect(guestStayBucket(stay({ checkOut: "2026-10-14" }), today)).toBe("past");
    // The host's answer stays in Upcoming while the dates are ahead, so a guest sees Declined / Expired.
    expect(guestStayBucket(stay({ status: "declined" }), today)).toBe("upcoming");
    expect(guestStayBucket(stay({ status: "expired" }), today)).toBe("upcoming");
    expect(guestStayBucket(stay({ status: "declined", checkOut: "2026-10-14" }), today)).toBe("past");
    expect(guestStayBucket(stay({ status: "cancelled" }), today)).toBe("past");
    expect(parseGuestStayBucket("past")).toBe("past");
    expect(parseGuestStayBucket("nope")).toBeNull();
  });

  it("sorts soonest first for Upcoming and newest first for Past", () => {
    const list = [stay({ id: "b", checkIn: "2026-10-25" }), stay({ id: "a", checkIn: "2026-10-20" })];
    expect(sortGuestStays(list, "upcoming").map((s) => s.id)).toEqual(["a", "b"]);
    expect(sortGuestStays(list, "past").map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("prints the pending hours and plain status words (no pill)", () => {
    const now = new Date("2026-10-14T20:00:00Z");
    expect(holdExpiresInLabel("2026-10-15T18:30:00Z", now)).toBe("Pending, expires in 22h");
    expect(holdExpiresInLabel("2026-10-14T20:40:00Z", now)).toBe("Pending, expires in 40m");
    expect(holdExpiresInLabel("2026-10-14T19:00:00Z", now)).toBe("Pending, expiring");
    expect(holdExpiresInLabel(null, now)).toBe("Pending");
    expect(guestStayStatusLabel(stay(), today)).toBe("Confirmed");
    expect(guestStayStatusLabel(stay({ payment: "due" }), today)).toBe("Approved, pay now");
    expect(guestStayStatusLabel(stay({ payment: "processing" }), today)).toBe("Approved, payment processing");
    expect(guestStayStatusLabel(stay({ payment: "paid" }), today)).toBe("Confirmed");
    expect(guestStayStatusLabel(stay({ checkOut: "2026-10-10" }), today)).toBe("Completed");
    expect(guestStayStatusLabel(stay({ status: "declined" }), today)).toBe("Declined");
    expect(guestStayStatusLabel(stay({ status: "expired" }), today)).toBe("Expired");
  });

  it("a hold is 24 hours", () => {
    expect(shortStayHoldExpiresAt(new Date("2026-10-14T20:00:00Z"))).toBe("2026-10-15T20:00:00.000Z");
  });
});

describe("what the button says is decided from the per-range answers", () => {
  const confirmed = { outcome: "confirmed" as const };
  const pending = { outcome: "pending" as const };
  const refused = { outcome: "unavailable" as const };
  it("confirm, request, mixed, none", () => {
    expect(guestBookActionLabel(guestBookAction([confirmed, confirmed]))).toBe("Confirm stay");
    expect(guestBookActionLabel(guestBookAction([pending]))).toBe("Request to book");
    expect(guestBookAction([confirmed, pending, refused])).toBe("mixed");
    expect(guestBookActionLabel("mixed")).toBe("Confirm and request");
    expect(guestBookAction([refused])).toBe("none");
    expect(guestBookSummaryLine([confirmed, confirmed, pending])).toBe("2 confirmed, 1 pending");
  });
});

describe("the guest's texts", () => {
  const input = { roomLabel: "Attic Nook", propertyLabel: "Cedar Court Short Stays", checkIn: "2026-10-15", checkOut: "2026-10-16", nights: 1, total: 140 };
  const url = "https://proplane.ai/resident/stays/upcoming";
  it("match the plan and carry no long dash", () => {
    const texts = [
      guestStayConfirmedText(input, url),
      guestStayRequestedText({ ...input, checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3, total: 420 }),
      guestStayApprovedText({ ...input, checkIn: "2026-10-20", checkOut: "2026-10-23" }, url),
      guestStayDeclinedText({ ...input, checkIn: "2026-10-20", checkOut: "2026-10-23" }, url),
      guestStayExpiredText({ ...input, checkIn: "2026-10-30", checkOut: "2026-11-02" }, url),
    ];
    expect(texts[0]).toBe(`PropLane: Confirmed, Attic Nook at Cedar Court Short Stays, Oct 15 to 16 (1 night, $140). Check-in details are in your portal: ${url}`);
    expect(texts[1]).toBe("PropLane: Request sent for Oct 20 to 23 (3 nights, $420). The host has 24 hours to confirm; we'll text you.");
    expect(texts[2]).toBe(`PropLane: Confirmed, Oct 20 to 23 at Cedar Court Short Stays. See it in your portal: ${url}`);
    expect(texts[3]).toBe(`PropLane: The host couldn't confirm Oct 20 to 23. Other nights are open in your portal: ${url}`);
    expect(texts[4]).toContain("Oct 30 to Nov 2");
    for (const text of texts) expect(text).not.toMatch(/[–—]/);
  });

  it("points at the sign-in page, never a one-time link", () => {
    expect(withGuestSignInPrompt("Got it.", "https://x/")).toBe("Got it. Sign in at https://x/auth/sign-in to see your stays.");
    expect(withGuestSignInPrompt("Got it.", "")).toBe("Got it.");
  });
});

describe("a manager's save does not strip what the server owns", () => {
  const stored = { residentUserId: GUEST, guests: 3, stayDetails: { source: "guest_portal", guests: 3, holdExpiresAt: "2026-10-15T00:00:00Z" }, roomId: "r4" };
  it("carries the login, the head-count and the deadline forward", () => {
    const next = carryGuestStayFields(stored, { roomId: "r4", checkIn: "2026-10-20", stayDetails: { linen: "Requested" } })!;
    expect(next.residentUserId).toBe(GUEST);
    expect(next.guests).toBe(3);
    expect(next.stayDetails).toEqual({ linen: "Requested", source: "guest_portal", guests: 3, holdExpiresAt: "2026-10-15T00:00:00Z" });
  });
  it("pins a request's source: a save cannot un-mark it and leave the request unanswerable", () => {
    expect((carryGuestStayFields(stored, { stayDetails: { source: "Airbnb" } })!.stayDetails as Record<string, unknown>).source).toBe("guest_portal");
  });
  it("never overrides another value the save sets, and leaves a manager's own booking alone", () => {
    expect((carryGuestStayFields(stored, { stayDetails: { linen: "Delivered" } })!.stayDetails as Record<string, unknown>).linen).toBe("Delivered");
    // A manager's own stay keeps its editable source; only a guest's request is pinned.
    const manual = { residentUserId: GUEST, stayDetails: { source: "Direct" } };
    expect((carryGuestStayFields(manual, { stayDetails: { source: "Airbnb" } })!.stayDetails as Record<string, unknown>).source).toBe("Airbnb");
    expect(carryGuestStayFields({ roomId: "r1", stayDetails: { source: "Direct" } }, { stayDetails: {} })).toBeNull();
    expect(carryGuestStayFields(null, {})).toBeNull();
  });
});

describe("the guest's own list", () => {
  it("maps a stored block to its row", () => {
    const record = { id: "b1", property_id: "p", record_type: "room_date_block", row_data: { roomId: "r", checkIn: "2026-10-20", checkOut: "2026-10-23", bookingStatus: "hold", rate: 140, quotedNights: 3, quotedTotal: 420, stayDetails: { guests: 2, holdExpiresAt: "2026-10-15T20:00:00Z" } } };
    const meta = { propertyLabel: "Cedar Court", roomLabel: "Attic Nook", canBookAgain: true };
    expect(guestStayFromRecord(record, meta)).toMatchObject({ status: "pending", guests: 2, nights: 3, total: 420, nightly: 140, holdExpiresAt: "2026-10-15T20:00:00Z", canBookAgain: true });
    expect(guestStayFromRecord({ ...record, record_type: "cancelled_room_date_block", row_data: { ...record.row_data, stayDetails: { decision: "declined" } } }, meta)).toMatchObject({ status: "declined", holdExpiresAt: null });
    expect(guestStayFromRecord({ ...record, record_type: "cancelled_room_date_block", row_data: { ...record.row_data, stayDetails: { decision: "expired" } } }, meta)?.status).toBe("expired");
    expect(guestStayFromRecord({ ...record, row_data: { roomId: "r" } }, meta)).toBeNull();
  });

  it("lists only this login's stays, with the house and room names, and says whether Book again is open", async () => {
    const db = seedShortStayDb({
      history: [
        completedStay({ roomId: "r1", quotedNights: 1, rate: 140 }),
        { ...completedStay({ residentUserId: "someone-else" }) },
      ],
    });
    const stays = await listGuestStays(db as never, { userId: GUEST });
    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ propertyId: PROPERTY, propertyLabel: "Cedar Court", roomLabel: "Attic Nook", status: "confirmed", canBookAgain: true });
  });

  it("closes Book again when the home no longer takes short stays", async () => {
    const db = seedShortStayDb({ history: [completedStay()], submission: { shortTermRentalsAllowed: false, shortTermDailyCost: "" } });
    const [only] = await listGuestStays(db as never, { userId: GUEST });
    expect(only!.canBookAgain).toBe(false);
  });
});
