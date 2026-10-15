import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const emitActionEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (...args: unknown[]) => emitActionEvent(...args) }));
const enqueueOwnerSms = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: (...args: unknown[]) => enqueueOwnerSms(...args) }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn(async () => new Response("{}", { status: 200 })) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
const chargeWrites: Array<Record<string, unknown>> = [];
let chargeDb: { tables: Record<string, Array<Record<string, unknown>>> } | null = null;
vi.mock("@/lib/household-charges.server", () => ({
  upsertManagerCharges: async (_db: unknown, _owner: string, charges: Array<Record<string, unknown>>) => {
    for (const charge of charges) {
      chargeWrites.push(charge);
      chargeDb?.tables.portal_household_charge_records!.push({ id: charge.id, row_data: charge });
    }
  },
}));

import { expireShortStayHolds } from "@/lib/short-stay-hold-expiry.server";
import { decideShortStayHold } from "@/lib/short-stay/hold-decisions.server";
import { evaluateReturningGuest } from "@/lib/short-stay/instant-book.server";
import { GUEST, OWNER, PROPERTY, seedShortStayDb } from "../helpers/short-stay-seed";

const BLOCK = "axis_room_block_owner-1_hold-1";

function holdRow(overrides: Record<string, unknown> = {}, stayDetails: Record<string, unknown> = {}) {
  return {
    id: BLOCK,
    manager_user_id: OWNER,
    property_id: PROPERTY,
    record_type: "room_date_block",
    starts_at: "2026-10-20T00:00:00",
    ends_at: "2026-10-23T00:00:00",
    row_data: {
      id: BLOCK,
      recordType: "room_date_block",
      propertyId: PROPERTY,
      roomId: "r1",
      checkIn: "2026-10-20",
      checkOut: "2026-10-23",
      bookingStatus: "hold",
      reason: "Short-stay request",
      rate: 140,
      rateBasis: "daily",
      quotedNights: 3,
      quotedTotal: 420,
      guests: 1,
      residentName: "Priya Natarajan",
      residentPhone: "+12065550142",
      residentUserId: GUEST,
      stayDetails: { source: "guest_portal", guests: 1, holdExpiresAt: "2026-10-15T08:00:00.000Z", ...stayDetails },
      ...overrides,
    },
  };
}

function seeded(row = holdRow()) {
  const db = seedShortStayDb();
  db.tables.portal_schedule_records!.push(row);
  chargeDb = db;
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  chargeWrites.length = 0;
  chargeDb = null;
});

describe("the host approves a guest's request", () => {
  it("confirms the hold, raises the stay_total charge and texts the guest from the work number", async () => {
    const db = seeded();
    const result = await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve" });
    expect(result).toEqual({ ok: true, outcome: "confirmed", decision: "approve", chargeCreated: true });
    const stored = db.tables.portal_schedule_records!.find((r) => r.id === BLOCK)!;
    expect(stored.record_type).toBe("room_date_block");
    expect(stored.row_data).toMatchObject({ bookingStatus: "confirmed", reason: "Short-stay confirmed", stayDetails: { decision: "approved", guests: 1, source: "guest_portal" } });
    expect((stored.row_data as { stayDetails: Record<string, unknown> }).stayDetails.holdExpiresAt).toBeUndefined();
    expect(chargeWrites).toHaveLength(1);
    expect(chargeWrites[0]).toMatchObject({ kind: "stay_total", amountLabel: "$420.00", residentUserId: GUEST });
    const sms = enqueueOwnerSms.mock.calls[0]![0] as { managerUserId: string; recipientPhone: string; body: string; purpose: string };
    expect(sms).toMatchObject({ managerUserId: OWNER, recipientPhone: "+12065550142", purpose: "short_stay_confirmed" });
    expect(sms.body).toBe("PropLane: Confirmed, Oct 20 to 23 at Cedar Court. See it in your portal: https://proplane.ai/resident/stays/upcoming");
    expect((emitActionEvent.mock.calls[0]![1] as { event: string; domain: string }).event).toBe("short_stay_confirmed");
    expect((emitActionEvent.mock.calls[0]![1] as { domain: string }).domain).toBe("channel_booking");
  });

  it("is idempotent: a second Approve changes nothing and raises no second charge", async () => {
    const db = seeded();
    await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve" });
    const again = await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve" });
    expect(again).toEqual({ ok: false, status: 409, error: "That request was already answered." });
    expect(chargeWrites).toHaveLength(1);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
  });

  it("raises no charge for a stay with no login: a typed, unverified email is never a payable key", async () => {
    // The public card's typed address stays on the row and nowhere else - keying `stay_total` on it
    // would raise the charge in the Payments of whoever really owns that address.
    const db = seeded(holdRow({ residentUserId: undefined, residentEmail: "typed@example.com" }, { source: "public_short_stay_request" }));
    const result = await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve" });
    expect(result).toMatchObject({ ok: true, outcome: "confirmed", chargeCreated: false });
    expect(chargeWrites).toHaveLength(0);
  });

  it("never overwrites a charge that already exists for the block (a paid one included)", async () => {
    const db = seeded();
    const { guestStayChargeId } = await import("@/lib/short-stay/stay-charge.server");
    db.tables.portal_household_charge_records!.push({ id: guestStayChargeId(BLOCK), row_data: { status: "paid" } });
    const result = await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve" });
    expect(result).toMatchObject({ ok: true, chargeCreated: false });
    expect(chargeWrites).toHaveLength(0);
  });
});

describe("the host declines, or the 24 hours run out", () => {
  it("decline cancels the block (the nights free up) and records why", async () => {
    const db = seeded();
    const result = await decideShortStayHold(db as never, { blockId: BLOCK, decision: "decline" });
    expect(result).toMatchObject({ ok: true, outcome: "cancelled" });
    const stored = db.tables.portal_schedule_records!.find((r) => r.id === BLOCK)!;
    expect(stored.record_type).toBe("cancelled_room_date_block");
    expect(stored.row_data).toMatchObject({ bookingStatus: "cancelled", recordType: "cancelled_room_date_block", reason: "Declined by host", stayDetails: { decision: "declined" } });
    expect(chargeWrites).toHaveLength(0);
    expect((enqueueOwnerSms.mock.calls[0]![0] as { body: string }).body).toBe("PropLane: The host couldn't confirm Oct 20 to 23. Other nights are open in your portal: https://proplane.ai/resident/stays/upcoming");
    expect((emitActionEvent.mock.calls[0]![1] as { event: string }).event).toBe("short_stay_declined");
    // A declined request ends instant booking for that guest on this listing.
    const history = db.tables.portal_schedule_records!.map((r) => ({ record_type: String(r.record_type), row_data: r.row_data as Record<string, unknown> }));
    expect(evaluateReturningGuest([...history, { record_type: "room_date_block", row_data: { bookingStatus: "confirmed", checkOut: "2026-09-02", residentUserId: GUEST } }], { userId: GUEST }, "2026-10-14")).toBe(false);
  });

  it("an answered request cannot be declined afterwards", async () => {
    const db = seeded();
    await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve" });
    expect(await decideShortStayHold(db as never, { blockId: BLOCK, decision: "decline" })).toMatchObject({ ok: false, status: 409 });
  });

  it("only a guest's request can be answered: a manager's own hold and an unknown id are refused", async () => {
    const db = seeded(holdRow({}, { source: "Direct" }));
    expect(await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve" })).toMatchObject({ ok: false, status: 409 });
    expect(await decideShortStayHold(db as never, { blockId: "missing", decision: "approve" })).toMatchObject({ ok: false, status: 404 });
  });

  it("the expiry cron cancels a hold whose 24 hours passed, texts the guest and tells the team", async () => {
    const db = seeded();
    const result = await expireShortStayHolds(db as never, new Date("2026-10-15T09:00:00Z"));
    expect(result).toMatchObject({ checked: 1, released: 1, failed: 0 });
    const stored = db.tables.portal_schedule_records!.find((r) => r.id === BLOCK)!;
    expect(stored.record_type).toBe("cancelled_room_date_block");
    expect(stored.row_data).toMatchObject({ reason: "Request expired", stayDetails: { decision: "expired" } });
    expect((enqueueOwnerSms.mock.calls[0]![0] as { purpose: string }).purpose).toBe("short_stay_expired");
    expect((emitActionEvent.mock.calls[0]![1] as { event: string }).event).toBe("short_stay_expired");
  });

  it("the cron leaves a hold alone until its deadline, and never expires an answered one", async () => {
    const db = seeded();
    expect(await expireShortStayHolds(db as never, new Date("2026-10-15T07:59:00Z"))).toMatchObject({ checked: 0, released: 0 });
    await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve" });
    enqueueOwnerSms.mockClear();
    expect(await expireShortStayHolds(db as never, new Date("2026-10-16T09:00:00Z"))).toMatchObject({ checked: 0 });
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });
});
