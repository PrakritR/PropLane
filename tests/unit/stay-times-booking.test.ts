/**
 * Booking carries the stay's real times and its add-on asks (bookings-times-1018, contract C): the row is
 * stamped with the property's check-in / check-out times and real instants (not midnight), the guest's
 * estimated arrival is stored but never moves a time, an add-on is kept only where it is available for those
 * exact nights, a hold keeps it `requested` with no charge, a confirmed stay raises its charge at once, and
 * the dry run reports availability per kind without writing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: vi.fn(async () => ({})) }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn(async () => new Response("{}", { status: 200 })) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
vi.mock("@/lib/channel-booking-events.server", () => ({ renderOwnerBookingEmail: () => ({}), sendOwnerBookingEmail: vi.fn(async () => undefined) }));
const availability = vi.fn();
vi.mock("@/lib/room-availability-range.server", () => ({ roomAvailabilityForRange: (...args: unknown[]) => availability(...args) }));
const rateLimit = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "1.2.3.4", rateLimit: (...a: unknown[]) => rateLimit(...a) }));
let chargeDb: ReturnType<typeof seedShortStayDb> | null = null;
const chargeWrites: Array<Record<string, unknown>> = [];
vi.mock("@/lib/household-charges.server", () => ({
  upsertManagerCharges: async (_db: unknown, _owner: string, charges: Array<Record<string, unknown>>) => {
    for (const charge of charges) {
      chargeWrites.push(charge);
      chargeDb?.tables.portal_household_charge_records!.push({ id: charge.id, status: charge.status, row_data: charge });
    }
  },
}));

import { bookGuestStays } from "@/lib/short-stay/guest-stays.server";
import { submitShortStayRequest } from "@/lib/short-stay-request.server";
import { stayAddOnChargeId } from "@/lib/short-stay/stay-add-ons";
import { GUEST, PROPERTY, TODAY, completedStay, seedShortStayDb } from "../helpers/short-stay-seed";

const NOW = new Date("2026-10-14T18:00:00Z");
const range = { checkIn: "2026-10-21", checkOut: "2026-10-24" };

function seededDb(opts: { returning?: boolean; others?: Array<Record<string, unknown>> } = {}) {
  // A returning guest is confirmed at once only on a listing whose host ticked the switch (default OFF).
  const db = seedShortStayDb({ history: opts.returning ? [completedStay()] : [], ...(opts.returning ? { submission: { shortStayInstantBookReturning: true } } : {}) });
  for (const other of opts.others ?? []) db.tables.portal_schedule_records!.push(other as never);
  chargeDb = db;
  return db;
}

const book = (db: ReturnType<typeof seededDb>, body: Record<string, unknown>) =>
  bookGuestStays(db as never, { userId: GUEST, today: TODAY, now: NOW, body: { propertyId: PROPERTY, roomId: "r1", guests: 1, ranges: [range], ...body } });

const stays = (db: ReturnType<typeof seededDb>) =>
  db.tables.portal_schedule_records!.filter((r) => (r.row_data as { stayDetails?: { source?: string } }).stayDetails?.source === "guest_portal" && r.id !== "history-0");

const neighbour = (checkIn: string, checkOut: string) => ({
  id: "neighbour",
  property_id: PROPERTY,
  record_type: "room_date_block",
  starts_at: `${checkIn}T22:00:00.000Z`,
  ends_at: `${checkOut}T18:00:00.000Z`,
  row_data: { id: "neighbour", propertyId: PROPERTY, roomId: "r1", checkIn, checkOut, checkInTime: "15:00", checkOutTime: "11:00", bookingStatus: "confirmed", stayDetails: { source: "direct" } },
});

beforeEach(() => {
  vi.clearAllMocks();
  chargeWrites.length = 0;
  chargeDb = null;
  availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: true }] }));
});

describe("a guest's booking stamps real times", () => {
  it("writes the property's check-in and check-out times and their real instants, not midnight", async () => {
    const db = seededDb();
    const result = await book(db, { estimatedArrival: "18:30" });
    expect(result).toMatchObject({ ok: true, action: "request" });
    const row = stays(db)[0]!;
    expect(row.row_data).toMatchObject({ checkInTime: "15:00", checkOutTime: "11:00", startsAt: "2026-10-21T22:00:00.000Z", endsAt: "2026-10-24T18:00:00.000Z" });
    expect(row).toMatchObject({ starts_at: "2026-10-21T22:00:00.000Z", ends_at: "2026-10-24T18:00:00.000Z" });
  });

  it("stores the estimated arrival without ever moving the check-in; a bad value is dropped", async () => {
    const db = seededDb();
    await book(db, { estimatedArrival: "13:00" });
    expect(stays(db)[0]!.row_data).toMatchObject({ checkInTime: "15:00", stayDetails: { estimatedArrival: "13:00" } });
    const other = seededDb();
    await book(other, { estimatedArrival: "whenever" });
    expect((stays(other)[0]!.row_data as { stayDetails: Record<string, unknown> }).stayDetails.estimatedArrival).toBeUndefined();
  });

  it("a property's own times win over the defaults", async () => {
    const db = seededDb();
    (db.tables.manager_property_records![0]!.property_data as { listingSubmission: Record<string, unknown> }).listingSubmission.stayTimes = {
      checkInTime: "16:00",
      checkOutTime: "10:00",
      earlyCheckInPriceCents: 4000,
    };
    await book(db, { addOns: ["early_check_in"] });
    expect(stays(db)[0]!.row_data).toMatchObject({
      checkInTime: "16:00",
      checkOutTime: "10:00",
      stayDetails: { addOns: { early_check_in: { status: "requested", time: "12:00", priceCents: 4000 } } },
    });
  });
});

describe("add-ons asked for at booking", () => {
  it("a hold keeps them `requested` and raises no charge", async () => {
    const db = seededDb();
    await book(db, { addOns: ["early_check_in", "late_check_out"] });
    const row = stays(db)[0]!.row_data as { bookingStatus: string; stayDetails: { addOns: Record<string, Record<string, unknown>> } };
    expect(row.bookingStatus).toBe("hold");
    expect(row.stayDetails.addOns.early_check_in).toMatchObject({ status: "requested", time: "12:00", priceCents: 2500 });
    expect(row.stayDetails.addOns.late_check_out).toMatchObject({ status: "requested", time: "14:00", priceCents: 2500 });
    expect(chargeWrites.filter((c) => c.stayAddOn)).toHaveLength(0);
  });

  it("an instant confirm raises each add-on's charge at once, on the guest's login, and never a booking id", async () => {
    const db = seededDb({ returning: true });
    const result = await book(db, { addOns: ["early_check_in"] });
    expect(result).toMatchObject({ ok: true, action: "confirm" });
    const blockId = (result as { results: Array<{ stayId?: string }> }).results[0]!.stayId!;
    const charge = chargeWrites.find((c) => c.stayAddOn === "early_check_in")!;
    expect(charge).toMatchObject({ id: stayAddOnChargeId(blockId, "early_check_in"), residentUserId: GUEST, residentEmail: "priya@example.com", guestStayBlockId: blockId, amountLabel: "$25.00" });
    expect(charge).not.toHaveProperty("shortStayBookingId");
    const row = stays(db).find((r) => r.id === blockId)!.row_data as { stayDetails: { addOns: Record<string, Record<string, unknown>> } };
    expect(row.stayDetails.addOns.early_check_in).toMatchObject({ status: "pending", chargeId: charge.id });
    // the stay itself still has exactly one stay_total
    expect(chargeWrites.filter((c) => c.kind === "stay_total")).toHaveLength(1);
  });

  it("keeps an add-on only where it is available for those exact nights, and says which it dropped", async () => {
    // A guest checks out at 11:00 on the 21st: noon on the 21st is inside the cleaning buffer.
    const db = seededDb({ others: [neighbour("2026-10-18", "2026-10-21")] });
    const result = await book(db, { addOns: ["early_check_in", "late_check_out"] });
    const row = stays(db)[0]!.row_data as { stayDetails: { addOns: Record<string, unknown> } };
    expect(Object.keys(row.stayDetails.addOns)).toEqual(["late_check_out"]);
    expect((result as { results: Array<{ addOnsSkipped?: string[] }> }).results[0]!.addOnsSkipped).toEqual(["early_check_in"]);
  });

  it("the dry run reports availability per kind (never why) and writes nothing", async () => {
    const db = seededDb({ others: [neighbour("2026-10-18", "2026-10-21")] });
    const before = db.tables.portal_schedule_records!.length;
    const result = await book(db, { dryRun: true });
    expect(db.tables.portal_schedule_records!.length).toBe(before);
    const offers = (result as { results: Array<{ addOns: unknown[] }> }).results[0]!.addOns;
    expect(offers).toEqual([{ kind: "early_check_in", available: false }, { kind: "late_check_out", available: true, time: "14:00", priceCents: 2500 }]);
  });

  it("an unknown add-on name asks for nothing", async () => {
    const db = seededDb();
    await book(db, { addOns: ["spa_day", 7, null] });
    expect((stays(db)[0]!.row_data as { stayDetails: Record<string, unknown> }).stayDetails.addOns).toBeUndefined();
  });
});

describe("the public card", () => {
  const publicBody = { propertyId: PROPERTY, roomId: "r1", guests: 1, ...range };

  it("a dry run needs no name or phone, writes nothing, and answers the add-on offers", async () => {
    const db = seededDb({ others: [neighbour("2026-10-24", "2026-10-26")] });
    const before = db.tables.portal_schedule_records!.length;
    const result = await submitShortStayRequest(db as never, { ...publicBody, dryRun: true }, { today: TODAY });
    expect(db.tables.portal_schedule_records!.length).toBe(before);
    expect(result).toEqual({
      ok: true,
      addOns: [{ kind: "early_check_in", available: true, time: "12:00", priceCents: 2500 }, { kind: "late_check_out", available: false }],
    });
  });

  it("a request stamps the times and keeps the add-on as `requested` on the hold", async () => {
    const db = seededDb();
    const result = await submitShortStayRequest(
      db as never,
      { ...publicBody, name: "Sam Rivera", phone: "(206) 555-0199", email: "sam@example.com", estimatedArrival: "14:00", addOns: ["late_check_out"] },
      { today: TODAY },
    );
    expect(result).toEqual({ ok: true });
    const row = db.tables.portal_schedule_records!.find((r) => (r.row_data as { stayDetails?: { source?: string } }).stayDetails?.source === "public_short_stay_request")!.row_data as Record<string, unknown>;
    expect(row).toMatchObject({ bookingStatus: "hold", checkInTime: "15:00", checkOutTime: "11:00", stayDetails: { estimatedArrival: "14:00", addOns: { late_check_out: { status: "requested", priceCents: 2500 } } } });
    expect(chargeWrites).toHaveLength(0);
  });
});
