import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const emitActionEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (...args: unknown[]) => emitActionEvent(...args) }));
const enqueueOwnerSms = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: (...args: unknown[]) => enqueueOwnerSms(...args) }));
const deliverInbox = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: (...args: unknown[]) => deliverInbox(...args) }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn(async () => new Response("{}", { status: 200 })) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
const availability = vi.fn();
vi.mock("@/lib/room-availability-range.server", () => ({ roomAvailabilityForRange: (...args: unknown[]) => availability(...args) }));
const chargeWrites: Array<Record<string, unknown>> = [];
vi.mock("@/lib/household-charges.server", () => ({
  upsertManagerCharges: async (_db: unknown, _owner: string, charges: Array<Record<string, unknown>>) => {
    chargeWrites.push(...charges);
  },
}));

import {
  evaluateReturningGuest,
  instantBookStatus,
  listingBooksReturningGuestsInstantly,
  returningGuestRowFilter,
} from "@/lib/short-stay/instant-book.server";
import { bookGuestStays } from "@/lib/short-stay/guest-stays.server";
import { GUEST, OWNER, PROPERTY, TODAY, completedStay, seedShortStayDb } from "../helpers/short-stay-seed";

const tomorrow = { checkIn: "2026-10-15", checkOut: "2026-10-16" };
const nextWeek = { checkIn: "2026-10-21", checkOut: "2026-10-24" };

/** The host ticked "Returning guests book instantly": the switch is OFF unless a listing saved it on. */
const seedInstant = (opts: Parameters<typeof seedShortStayDb>[0] = {}) => seedShortStayDb({ ...opts, submission: { shortStayInstantBookReturning: true, ...opts?.submission } });

const book = (db: ReturnType<typeof seedShortStayDb>, body: Record<string, unknown>) =>
  bookGuestStays(db as never, { userId: GUEST, today: TODAY, body: { propertyId: PROPERTY, roomId: "r1", guests: 1, ...body } });

beforeEach(() => {
  vi.clearAllMocks();
  chargeWrites.length = 0;
  availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: true }] }));
});

describe("the instant-book rule (pure)", () => {
  const completed = { record_type: "room_date_block", row_data: completedStay().row_data };
  const who = { userId: GUEST };

  it("is OFF unless the host saved it on (a web request is an application the host answers)", () => {
    expect(listingBooksReturningGuestsInstantly({})).toBe(false);
    expect(listingBooksReturningGuestsInstantly({ shortStayInstantBookReturning: true })).toBe(true);
    expect(listingBooksReturningGuestsInstantly({ shortStayInstantBookReturning: false })).toBe(false);
    expect(listingBooksReturningGuestsInstantly(null)).toBe(false);
  });

  it("needs a COMPLETED confirmed stay: a future, pending or cancelled one does not count", () => {
    expect(evaluateReturningGuest([completed], who, TODAY)).toBe(true);
    expect(evaluateReturningGuest([{ ...completed, row_data: { ...completed.row_data, checkOut: "2026-10-20" } }], who, TODAY)).toBe(false);
    expect(evaluateReturningGuest([{ ...completed, row_data: { ...completed.row_data, bookingStatus: "hold" } }], who, TODAY)).toBe(false);
    expect(evaluateReturningGuest([{ record_type: "cancelled_room_date_block", row_data: completed.row_data }], who, TODAY)).toBe(false);
    expect(evaluateReturningGuest([], who, TODAY)).toBe(false);
  });

  it("a request the host declined ends it, wherever the completed stay is", () => {
    const declined = { record_type: "cancelled_room_date_block", row_data: { ...completed.row_data, bookingStatus: "cancelled", stayDetails: { decision: "declined" } } };
    expect(evaluateReturningGuest([completed, declined], who, TODAY)).toBe(false);
    const expired = { ...declined, row_data: { ...declined.row_data, stayDetails: { decision: "expired" } } };
    expect(evaluateReturningGuest([completed, expired], who, TODAY)).toBe(true);
  });

  it("never reads another guest's stay", () => {
    expect(evaluateReturningGuest([completed], { userId: "someone-else" }, TODAY)).toBe(false);
  });

  it("matches a legacy row by email, and by phone only once that phone is verified", () => {
    const legacy = { record_type: "room_date_block", row_data: { bookingStatus: "confirmed", checkOut: "2026-09-02", residentEmail: "Priya@Example.com", residentPhone: "(206) 555-0142" } };
    expect(evaluateReturningGuest([legacy], { email: "priya@example.com" }, TODAY)).toBe(true);
    // A number typed into Settings is a claim, not an identity: it buys no instant-book standing.
    expect(evaluateReturningGuest([legacy], { phone: "+12065550142" }, TODAY)).toBe(false);
    expect(evaluateReturningGuest([legacy], { phone: "+12065550142", phoneVerified: true }, TODAY)).toBe(true);
  });

  it("reads only the rows it can match: the house's whole stay history is never pulled", () => {
    expect(returningGuestRowFilter({ userId: GUEST, email: "priya@example.com", phone: "+12065550142" })).toBe(
      'row_data->>residentUserId.eq."guest-1",row_data->>residentEmail.ilike."priya@example.com"',
    );
    // A verified phone is an identity, an unverified one is not - the same rule `rowMatchesGuest` applies.
    expect(returningGuestRowFilter({ userId: GUEST, phone: "+12065550142", phoneVerified: true })).toBe(
      'row_data->>residentUserId.eq."guest-1",row_data->>residentPhone.eq."+12065550142"',
    );
    // A phone-keyed placeholder login is nobody's typed address, so it is not a scope either.
    expect(returningGuestRowFilter({ userId: GUEST, email: "guest.12065550142@import.proplane.local" })).toBe(
      'row_data->>residentUserId.eq."guest-1"',
    );
    // No identity at all must read no rows, never the unfiltered listing.
    expect(returningGuestRowFilter({})).toBeNull();
  });

  it("confirms only when the flag is on AND the guest is returning", () => {
    expect(instantBookStatus({ flagOn: true, returning: true })).toBe("confirmed");
    expect(instantBookStatus({ flagOn: true, returning: false })).toBe("hold");
    expect(instantBookStatus({ flagOn: false, returning: true })).toBe("hold");
  });
});

describe("a returning guest books 1 night tomorrow and 3 nights next week", () => {
  it("writes both ranges confirmed at once, raises one stay_total charge each and texts once", async () => {
    const db = seedInstant({ history: [completedStay()] });
    const result = await book(db, { ranges: [tomorrow, nextWeek] });
    expect(result).toMatchObject({ ok: true, dryRun: false, action: "confirm", summary: "2 confirmed" });

    const rows = db.tables.portal_schedule_records!.filter((r) => String(r.id).startsWith("axis_room_block_"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.record_type).toBe("room_date_block");
      expect(row.row_data).toMatchObject({
        bookingStatus: "confirmed",
        residentUserId: GUEST,
        residentName: "Priya Natarajan",
        residentPhone: "+12065550142",
        rate: 140,
        stayDetails: { source: "guest_portal", guests: 1 },
      });
      expect((row.row_data as { stayDetails: Record<string, unknown> }).stayDetails.holdExpiresAt).toBeUndefined();
    }
    expect(chargeWrites).toHaveLength(2);
    expect(chargeWrites[0]).toMatchObject({ kind: "stay_total", status: "pending", residentUserId: GUEST, residentEmail: "priya@example.com", amountLabel: "$140.00", managerUserId: OWNER });
    expect(chargeWrites[1]).toMatchObject({ amountLabel: "$420.00" });
    expect(chargeWrites[0]!.residentVisibleAt).toBeTruthy();
    expect(String(chargeWrites[0]!.id)).toMatch(/^hc_mgr_stay_.*_stay_total$/);
    // The charge must never carry the field the Stripe webhook reads to settle a legacy pay-to-hold booking.
    expect(chargeWrites[0]).not.toHaveProperty("shortStayBookingId");
    // Made in the portal, answered in the portal: email + inbox, never a text, never a /l/ pay link.
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
    expect(deliverInbox).toHaveBeenCalledTimes(2);
    for (const call of deliverInbox.mock.calls) {
      const opts = call[1] as { deliverViaSms: boolean; suppressSms: boolean; toUserIds: string[]; text: string };
      expect(opts).toMatchObject({ deliverViaSms: false, suppressSms: true, toUserIds: [GUEST] });
      expect(opts.text).toContain("https://proplane.ai/resident/payments/pending");
      expect(opts.text).not.toContain("/l/");
    }
    const events = emitActionEvent.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toEqual(["short_stay_confirmed", "short_stay_confirmed"]);
  });

  it("a single confirmed range gets the plan's text (no dashes)", async () => {
    const db = seedInstant({ history: [completedStay()] });
    await book(db, { ranges: [tomorrow] });
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
    const body = (deliverInbox.mock.calls[0]![1] as { text: string }).text;
    expect(body).toContain("Confirmed: Attic Nook at Cedar Court, Oct 15 to 16 (1 night, $140).");
    expect(body).toContain("Pay $140 in Payments within 24 hours to keep it: https://proplane.ai/resident/payments/pending");
    expect(body).toContain("https://proplane.ai/resident/stays/upcoming");
    expect(body).not.toMatch(/[–—]/);
  });
});

describe("a first-time guest, or a listing with instant book off, requests to book", () => {
  it("writes a 24-hour hold with holdExpiresAt, raises no charge and tells the team", async () => {
    const db = seedInstant();
    const before = Date.now();
    const result = await book(db, { ranges: [tomorrow, nextWeek] });
    expect(result).toMatchObject({ ok: true, action: "request", summary: "2 pending" });
    const rows = db.tables.portal_schedule_records!.filter((r) => String(r.id).startsWith("axis_room_block_"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const data = row.row_data as { bookingStatus: string; stayDetails: { holdExpiresAt: string; guests: number; source: string } };
      expect(data.bookingStatus).toBe("hold");
      expect(data.stayDetails.source).toBe("guest_portal");
      const expiresIn = Date.parse(data.stayDetails.holdExpiresAt) - before;
      expect(expiresIn).toBeGreaterThan(23.9 * 3_600_000);
      expect(expiresIn).toBeLessThan(24.1 * 3_600_000);
    }
    expect(chargeWrites).toHaveLength(0);
    expect(emitActionEvent.mock.calls.map((c) => (c[1] as { event: string }).event)).toEqual(["short_stay_requested", "short_stay_requested"]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
    expect((deliverInbox.mock.calls[0]![1] as { text: string }).text).toContain("They have 24 hours to answer");
  });

  it("holds a returning guest when the listing never saved the switch (default OFF)", async () => {
    const db = seedShortStayDb({ history: [completedStay()] });
    expect(await book(db, { ranges: [tomorrow] })).toMatchObject({ action: "request" });
  });

  it("holds a returning guest when the listing switched instant book off", async () => {
    const db = seedInstant({ history: [completedStay()], submission: { shortStayInstantBookReturning: false } });
    expect(await book(db, { ranges: [tomorrow] })).toMatchObject({ action: "request" });
  });

  it("holds a returning guest the host once declined", async () => {
    const declined = { record_type: "cancelled_room_date_block", row_data: { ...completedStay().row_data, checkIn: "2026-09-10", checkOut: "2026-09-11", bookingStatus: "cancelled", stayDetails: { decision: "declined" } } };
    const db = seedInstant({ history: [completedStay(), declined] });
    expect(await book(db, { ranges: [tomorrow] })).toMatchObject({ action: "request" });
  });
});

describe("what the server's dry run tells the sheet", () => {
  it("answers the button without writing anything", async () => {
    const db = seedInstant({ history: [completedStay()] });
    const before = db.tables.portal_schedule_records!.length;
    const result = await book(db, { ranges: [tomorrow], dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true, action: "confirm", results: [{ outcome: "confirmed", total: 140 }] });
    expect(db.tables.portal_schedule_records!.length).toBe(before);
    expect(chargeWrites).toHaveLength(0);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("marks a taken range unavailable while the free one still goes through", async () => {
    availability.mockImplementation(async (input: { roomId: string; moveIn: string }) => ({
      ok: true,
      rooms: [{ roomId: input.roomId, available: input.moveIn !== nextWeek.checkIn }],
    }));
    const db = seedInstant({ history: [completedStay()] });
    const result = await book(db, { ranges: [tomorrow, nextWeek] });
    expect(result).toMatchObject({ ok: true, action: "confirm", summary: "1 confirmed" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.results.map((r) => r.outcome)).toEqual(["confirmed", "unavailable"]);
    expect(result.results[1]!.error).toBe("That room was just booked for those dates.");
    expect(chargeWrites).toHaveLength(1);
  });

  it("a 409 from the capacity trigger lands on that range alone and nothing else is lost", async () => {
    let writes = 0;
    const db = seedInstant({
      history: [completedStay()],
      failWrite: (table, mode) => (table === "portal_schedule_records" && mode === "upsert" && ++writes === 2 ? { code: "P4001", message: "Those dates are no longer available." } : null),
    });
    const result = await book(db, { ranges: [tomorrow, nextWeek] });
    if (!result.ok) throw new Error("unreachable");
    expect(result.results.map((r) => r.outcome)).toEqual(["confirmed", "unavailable"]);
    expect(db.tables.portal_schedule_records!.filter((r) => String(r.id).startsWith("axis_room_block_"))).toHaveLength(1);
  });

  it("refuses a bad range or an overlapping one by itself", async () => {
    const db = seedInstant({ history: [completedStay()] });
    const result = await book(db, { ranges: [tomorrow, { checkIn: "2026-10-15", checkOut: "2026-10-17" }, { checkIn: "2026-10-01", checkOut: "2026-10-02" }] });
    if (!result.ok) throw new Error("unreachable");
    expect(result.results.map((r) => r.outcome)).toEqual(["confirmed", "invalid", "invalid"]);
    expect(result.results[1]!.error).toBe("These dates overlap another stay in this request.");
    expect(result.results[2]!.error).toBe("Check-in can't be in the past.");
  });
});

describe("request limits", () => {
  it("refuses more than five ranges and too many guests for the room", async () => {
    const db = seedInstant({ history: [completedStay()] });
    const many = Array.from({ length: 6 }, (_, i) => ({ checkIn: `2026-11-0${i + 1}`, checkOut: `2026-11-0${i + 2}` }));
    expect(await book(db, { ranges: many })).toMatchObject({ ok: false, status: 400 });
    expect(await book(db, { ranges: [tomorrow], guests: 2 })).toMatchObject({ ok: false, status: 400, error: "That's more guests than the room sleeps." });
  });

  it("needs no mobile number for a PORTAL stay (it is answered by email and the resident inbox)", async () => {
    const noPhone = seedInstant({ guestPhone: null, history: [completedStay()] });
    expect(await book(noPhone, { ranges: [tomorrow] })).toMatchObject({ ok: true });
    // A stay booked by TEXT is answered by text, so that path still needs one.
    const texted = seedInstant({ guestPhone: null });
    expect(
      await bookGuestStays(texted as never, {
        userId: GUEST,
        today: TODAY,
        via: "sms",
        body: { propertyId: PROPERTY, roomId: "r1", guests: 1, ranges: [tomorrow] },
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("answers a dry run before any profile check: the Stay step's availability probe is never a profile error", async () => {
    const noPhone = seedInstant({ guestPhone: null });
    const dry = await book(noPhone, { ranges: [tomorrow], dryRun: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true });
  });

  it("caps open requests per guest", async () => {
    const pending = Array.from({ length: 6 }, (_, i) => ({
      row_data: { bookingStatus: "hold", propertyId: PROPERTY, roomId: "r1", checkIn: `2026-12-0${i + 1}`, checkOut: `2026-12-0${i + 2}`, residentUserId: GUEST, stayDetails: { holdExpiresAt: "2026-10-15T00:00:00Z" } },
    }));
    const db = seedInstant({ history: pending });
    expect(await book(db, { ranges: [tomorrow] })).toMatchObject({ ok: false, status: 429 });
    // A dry run is only a question, so it is never capped.
    expect(await book(db, { ranges: [tomorrow], dryRun: true })).toMatchObject({ ok: true });
  });
});
