/**
 * Paid early check-in / late checkout on a guest's own short stay (bookings-times-1018, contract C): the
 * request (availability, price from the property, one charge however often it is tapped, the charge keyed on
 * the guest's login and never on a booking id), the hold that only records the request until the host
 * confirms, and the PAID side (the stay's time moves, or the money goes back automatically, exactly once).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const spies = vi.hoisted(() => ({
  emitActionEvent: vi.fn(async (..._args: unknown[]) => ({})),
  enqueueOwnerSms: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  refreshTurnoverCleaningTimes: vi.fn(async (..._args: unknown[]) => undefined),
  refundPaidHouseholdCharge: vi.fn(async (..._args: unknown[]) => ({ refundId: "re_1", rail: "destination" as const })),
  ReviewError: class extends Error {},
  createHouseholdChargeCheckout: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, mode: "hosted" as const, url: "https://checkout.stripe.test/c/cs_test_1" })),
}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: spies.emitActionEvent }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: spies.enqueueOwnerSms }));
vi.mock("@/lib/vendor-dispatch/turnover-timing.server", () => ({ refreshTurnoverCleaningTimes: spies.refreshTurnoverCleaningTimes }));
vi.mock("@/lib/household-charge-refund-rail.server", () => ({
  refundPaidHouseholdCharge: spies.refundPaidHouseholdCharge,
  HouseholdChargeRefundReviewError: spies.ReviewError,
}));
vi.mock("@/lib/stripe-household-charge-checkout.server", () => ({ createHouseholdChargeCheckout: spies.createHouseholdChargeCheckout }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn(async () => new Response("{}", { status: 200 })) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
vi.mock("@/lib/channel-booking-events.server", () => ({ renderOwnerBookingEmail: () => ({}), sendOwnerBookingEmail: vi.fn(async () => undefined) }));

let chargeDb: ReturnType<typeof seedShortStayDb> | null = null;
const chargeWrites: Array<Record<string, unknown>> = [];
vi.mock("@/lib/household-charges.server", () => ({
  upsertManagerCharges: async (_db: unknown, _owner: string, charges: Array<Record<string, unknown>>) => {
    for (const charge of charges) {
      chargeWrites.push(charge);
      const rows = chargeDb!.tables.portal_household_charge_records!;
      const next = { id: charge.id, manager_user_id: charge.managerUserId, status: charge.status, row_data: charge };
      const at = rows.findIndex((row) => row.id === charge.id);
      if (at >= 0) rows[at] = next;
      else rows.push(next);
    }
  },
}));

import { decideShortStayHold } from "@/lib/short-stay/hold-decisions.server";
import { applyPaidStayAddOn, settleStayAddOnsForCharges, stayAddOnRefundKey } from "@/lib/short-stay/stay-add-on-settlement.server";
import { checkStayAddOnPayable, loadGuestStayForAddOns, quoteStayAddOns, requestStayAddOn } from "@/lib/short-stay/stay-add-ons.server";
import { stayAddOnChargeId } from "@/lib/short-stay/stay-add-ons";
import { GUEST, OWNER, PROPERTY, seedShortStayDb } from "../helpers/short-stay-seed";

const BLOCK = "axis_room_block_owner-1_stay-1";
const NOW = new Date("2026-10-14T18:00:00Z");

function stayRow(over: Record<string, unknown> = {}, details: Record<string, unknown> = {}) {
  return {
    id: BLOCK,
    manager_user_id: OWNER,
    property_id: PROPERTY,
    record_type: "room_date_block",
    starts_at: "2026-10-20T22:00:00.000Z",
    ends_at: "2026-10-23T18:00:00.000Z",
    updated_at: "2026-10-14T10:00:00.000Z",
    row_data: {
      id: BLOCK,
      recordType: "room_date_block",
      propertyId: PROPERTY,
      roomId: "r1",
      checkIn: "2026-10-20",
      checkOut: "2026-10-23",
      checkInTime: "15:00",
      checkOutTime: "11:00",
      bookingStatus: "confirmed",
      rate: 140,
      quotedNights: 3,
      quotedTotal: 420,
      guests: 1,
      residentName: "Priya Natarajan",
      residentPhone: "+12065550142",
      residentEmail: "typed-by-guest@elsewhere.test",
      residentUserId: GUEST,
      stayDetails: { source: "guest_portal", guests: 1, ...details },
      ...over,
    },
  };
}

function otherStay(id: string, checkIn: string, checkOut: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    manager_user_id: OWNER,
    property_id: PROPERTY,
    record_type: "room_date_block",
    starts_at: `${checkIn}T22:00:00.000Z`,
    ends_at: `${checkOut}T18:00:00.000Z`,
    row_data: { id, propertyId: PROPERTY, roomId: "r1", checkIn, checkOut, checkInTime: "15:00", checkOutTime: "11:00", bookingStatus: "confirmed", stayDetails: { source: "direct" }, ...extra },
  };
}

function seeded(opts: { stay?: ReturnType<typeof stayRow>; others?: Array<ReturnType<typeof otherStay>>; failWrite?: Parameters<typeof seedShortStayDb>[0] extends infer O ? (O extends { failWrite?: infer F } ? F : never) : never } = {}) {
  const db = seedShortStayDb({ failWrite: opts.failWrite });
  db.tables.portal_schedule_records!.push(opts.stay ?? stayRow(), ...(opts.others ?? []));
  db.tables.ledger_entries = [];
  chargeDb = db;
  return db;
}

const stored = (db: ReturnType<typeof seeded>) => db.tables.portal_schedule_records!.find((r) => r.id === BLOCK)!;
const storedData = (db: ReturnType<typeof seeded>) => stored(db).row_data as Record<string, unknown> & { stayDetails: { addOns?: Record<string, Record<string, unknown>> } };
const chargeRow = (db: ReturnType<typeof seeded>, kind: "early_check_in" | "late_check_out") =>
  db.tables.portal_household_charge_records!.find((r) => r.id === stayAddOnChargeId(BLOCK, kind));

/** What the Stripe webhook leaves behind once the guest paid: the charge is paid, its payment line carries the Stripe charge. */
function markPaid(db: ReturnType<typeof seeded>, kind: "early_check_in" | "late_check_out") {
  const row = chargeRow(db, kind)!;
  row.status = "paid";
  (row.row_data as Record<string, unknown>).status = "paid";
  db.tables.ledger_entries!.push({ source_charge_id: row.id, entry_type: "payment", stripe_charge_id: "ch_test_1", amount_cents: 2500 });
}

const ask = (db: ReturnType<typeof seeded>, kind: unknown, extra: Record<string, unknown> = {}) =>
  requestStayAddOn(db as never, { blockId: BLOCK, userId: GUEST, kind, appOrigin: "https://app.test", now: NOW, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  chargeWrites.length = 0;
  chargeDb = null;
});

describe("asking for an add-on", () => {
  it("raises ONE charge priced from the property, keyed on the guest's login, never on a booking id", async () => {
    const db = seeded();
    const result = await ask(db, "early_check_in");
    expect(result).toMatchObject({ ok: true, status: "pending", kind: "early_check_in", time: "12:00", priceCents: 2500, chargeId: stayAddOnChargeId(BLOCK, "early_check_in"), checkoutUrl: "https://checkout.stripe.test/c/cs_test_1" });
    expect(chargeWrites).toHaveLength(1);
    const charge = chargeWrites[0]!;
    expect(charge).toMatchObject({
      id: "hc_mgr_stay_axis_room_block_owner_1_stay_1_early_check_in",
      kind: "other_cost",
      amountLabel: "$25.00",
      status: "pending",
      managerUserId: OWNER,
      guestStayBlockId: BLOCK,
      stayAddOn: "early_check_in",
      // the LOGIN, from the profile - not the address the guest typed on the public card
      residentUserId: GUEST,
      residentEmail: "priya@example.com",
    });
    expect(charge).not.toHaveProperty("shortStayBookingId");
    expect(storedData(db).stayDetails.addOns!.early_check_in).toMatchObject({ status: "pending", time: "12:00", priceCents: 2500, chargeId: charge.id });
    // the checkout is opened for that one charge as the session's user
    expect(spies.createHouseholdChargeCheckout).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: GUEST, chargeIds: [charge.id], mode: "hosted", paymentMethod: "card" }));
  });

  it("a double tap is one charge and one stored record", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    const again = await ask(db, "early_check_in");
    expect(again).toMatchObject({ ok: true, status: "pending" });
    expect(chargeWrites).toHaveLength(1);
    expect(db.tables.portal_household_charge_records!.filter((r) => r.id === stayAddOnChargeId(BLOCK, "early_check_in"))).toHaveLength(1);
  });

  it("refuses with a 409 when the previous guest leaves too late for the cleaning buffer", async () => {
    // Checks out 11:00 on the 20th, so the clean runs to 2:00 pm: noon is not honorable.
    const db = seeded({ others: [otherStay("prev", "2026-10-17", "2026-10-20")] });
    const result = await ask(db, "early_check_in");
    expect(result).toMatchObject({ ok: false, status: 409, error: "Early check-in isn't available that day." });
    expect(chargeWrites).toHaveLength(0);
    expect(storedData(db).stayDetails.addOns).toBeUndefined();
  });

  it("refuses a late checkout when the next guest arrives the same afternoon, allows it a day later", async () => {
    const blocked = seeded({ others: [otherStay("next", "2026-10-23", "2026-10-25")] });
    expect(await ask(blocked, "late_check_out")).toMatchObject({ ok: false, status: 409 });
    const free = seeded({ others: [otherStay("next", "2026-10-24", "2026-10-25")] });
    expect(await ask(free, "late_check_out")).toMatchObject({ ok: true, status: "pending", time: "14:00" });
  });

  it("a cancelled neighbour does not block", async () => {
    const db = seeded({ others: [otherStay("prev", "2026-10-17", "2026-10-20", { bookingStatus: "cancelled" })] });
    expect(await ask(db, "early_check_in")).toMatchObject({ ok: true });
  });

  it("an imported channel stay blocks, a host's own closure (the export echoing back) does not", async () => {
    const db = seeded();
    db.tables.external_calendar_connections = [
      { property_id: PROPERTY, room_id: "r1", imported_ranges: [{ start: "2026-10-17", end: "2026-10-19", summary: "Reserved" }] },
    ];
    expect(await ask(db, "early_check_in")).toMatchObject({ ok: false, status: 409 });
    const echo = seeded();
    echo.tables.external_calendar_connections = [
      { property_id: PROPERTY, room_id: "r1", imported_ranges: [{ start: "2026-10-17", end: "2026-10-19", summary: "Airbnb (Not available)", hostBlock: true }] },
    ];
    expect(await ask(echo, "early_check_in")).toMatchObject({ ok: true });
  });

  it("the price and the window are the property's: a requested time outside it is refused, a price in the body means nothing", async () => {
    const db = seeded();
    expect(await ask(db, "early_check_in", { time: "09:00" })).toMatchObject({ ok: false, status: 409 });
    const ok = await ask(db, "early_check_in", { time: "13:00", priceCents: 1, amountLabel: "$0.01" });
    expect(ok).toMatchObject({ ok: true, priceCents: 2500, time: "13:00" });
    expect(chargeWrites[0]).toMatchObject({ amountLabel: "$25.00" });
  });

  it("a price below the checkout floor is not offered", async () => {
    const db = seeded();
    const property = db.tables.manager_property_records![0]!;
    (property.property_data as { listingSubmission: Record<string, unknown> }).listingSubmission.stayTimes = { earlyCheckInPriceCents: 0 };
    expect(await ask(db, "early_check_in")).toMatchObject({ ok: false, status: 409, error: "This add-on isn't offered for this home." });
    const ctx = await loadGuestStayForAddOns(db as never, { blockId: BLOCK, userId: GUEST });
    const rows = quoteStayAddOns(ctx!, { now: NOW });
    expect(rows.find((r) => r.kind === "early_check_in")!.offer.available).toBe(false);
    expect(rows.find((r) => r.kind === "late_check_out")!.offer).toMatchObject({ available: true, time: "14:00", priceCents: 2500 });
  });

  it("only the stay's own login can ask; anyone else's stay answers like a missing one", async () => {
    const db = seeded();
    expect(await requestStayAddOn(db as never, { blockId: BLOCK, userId: "someone-else", kind: "early_check_in", appOrigin: "https://app.test", now: NOW })).toMatchObject({ ok: false, status: 404 });
    expect(chargeWrites).toHaveLength(0);
  });

  it("refuses an unknown kind and a malformed time before reading anything", async () => {
    const db = seeded();
    expect(await ask(db, "free_upgrade")).toMatchObject({ ok: false, status: 400 });
    expect(await ask(db, "early_check_in", { time: "noonish" })).toMatchObject({ ok: false, status: 400 });
  });

  it("an add-on already paid cannot be bought twice", async () => {
    const db = seeded({ stay: stayRow({}, { addOns: { early_check_in: { time: "12:00", priceCents: 2500, status: "paid", chargeId: stayAddOnChargeId(BLOCK, "early_check_in") } } }) });
    expect(await ask(db, "early_check_in")).toMatchObject({ ok: false, status: 409 });
    expect(chargeWrites).toHaveLength(0);
  });

  it("falls back to the Payments page when Stripe's hosted page cannot start", async () => {
    spies.createHouseholdChargeCheckout.mockResolvedValueOnce({ ok: false, status: 422 } as never);
    const db = seeded();
    expect(await ask(db, "early_check_in")).toMatchObject({ ok: true, checkoutUrl: null, paymentsPath: "/resident/payments" });
  });
});

describe("a hold only records the request", () => {
  const holdStay = () =>
    stayRow({ bookingStatus: "hold" }, { holdExpiresAt: "2026-10-15T18:00:00.000Z" });

  it("stamps `requested`, raises no charge, and a second tap changes nothing", async () => {
    const db = seeded({ stay: holdStay() });
    expect(await ask(db, "early_check_in")).toMatchObject({ ok: true, status: "requested", chargeId: null, checkoutUrl: null });
    expect(await ask(db, "early_check_in")).toMatchObject({ ok: true, status: "requested" });
    expect(chargeWrites).toHaveLength(0);
    expect(storedData(db).stayDetails.addOns!.early_check_in).toMatchObject({ status: "requested", time: "12:00", priceCents: 2500 });
    expect(spies.createHouseholdChargeCheckout).not.toHaveBeenCalled();
  });

  it("the host's Approve raises the charge for a requested add-on, once", async () => {
    const db = seeded({ stay: holdStay() });
    await ask(db, "late_check_out");
    const approved = await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve", now: NOW });
    expect(approved).toMatchObject({ ok: true, outcome: "confirmed" });
    expect(chargeRow(db, "late_check_out")).toBeTruthy();
    expect(chargeWrites.filter((c) => c.stayAddOn === "late_check_out")).toHaveLength(1);
    expect(storedData(db).stayDetails.addOns!.late_check_out).toMatchObject({ status: "pending", chargeId: stayAddOnChargeId(BLOCK, "late_check_out") });
    // the same answer twice charges nothing more
    await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve", now: NOW });
    expect(chargeWrites.filter((c) => c.stayAddOn === "late_check_out")).toHaveLength(1);
  });

  it("an add-on that stopped being available while the request waited is dropped, not charged", async () => {
    const db = seeded({ stay: holdStay() });
    await ask(db, "early_check_in");
    // a booking took the room the day before while the host thought it over
    db.tables.portal_schedule_records!.push(otherStay("prev", "2026-10-17", "2026-10-20"));
    await decideShortStayHold(db as never, { blockId: BLOCK, decision: "approve", now: NOW });
    expect(chargeWrites.filter((c) => c.stayAddOn)).toHaveLength(0);
    expect(storedData(db).stayDetails.addOns).toBeUndefined();
  });
});

describe("paid", () => {
  async function paidEarly(db: ReturnType<typeof seeded>) {
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
  }

  it("moves the check-in, re-times the clean, texts the guest and tells the team", async () => {
    const db = seeded({ others: [otherStay("prev", "2026-10-17", "2026-10-19")] });
    await paidEarly(db);
    const result = await applyPaidStayAddOn(db as never, { chargeId: stayAddOnChargeId(BLOCK, "early_check_in"), now: NOW });
    expect(result).toMatchObject({ outcome: "applied", kind: "early_check_in", time: "12:00" });
    const row = storedData(db);
    expect(row).toMatchObject({ checkInTime: "12:00", checkOutTime: "11:00", startsAt: "2026-10-20T19:00:00.000Z" });
    expect(row.stayDetails.addOns!.early_check_in).toMatchObject({ status: "paid", time: "12:00" });
    expect(stored(db)).toMatchObject({ starts_at: "2026-10-20T19:00:00.000Z", ends_at: "2026-10-23T18:00:00.000Z" });
    // the clean that ENDS at this check-in is the previous guest's checkout
    expect(spies.refreshTurnoverCleaningTimes).toHaveBeenCalledWith(expect.anything(), { ownerUserId: OWNER, propertyId: PROPERTY, roomId: "r1", checkOutDate: "2026-10-19" });
    expect(spies.enqueueOwnerSms).toHaveBeenCalledTimes(1);
    expect(spies.enqueueOwnerSms.mock.calls[0]![0]).toMatchObject({
      recipientPhone: "+12065550142",
      body: "PropLane: Early check-in at 12:00 pm is confirmed for Oct 20.",
      purpose: "short_stay_add_on_confirmed",
    });
    expect(spies.emitActionEvent).toHaveBeenCalledTimes(1);
    expect(spies.emitActionEvent.mock.calls[0]![1]).toMatchObject({ domain: "channel_booking", category: "tours", event: "short_stay_add_on_paid" });
    expect(spies.refundPaidHouseholdCharge).not.toHaveBeenCalled();
  });

  it("a late checkout moves the checkout and re-times this stay's own clean", async () => {
    const db = seeded();
    await ask(db, "late_check_out");
    markPaid(db, "late_check_out");
    const result = await applyPaidStayAddOn(db as never, { chargeId: stayAddOnChargeId(BLOCK, "late_check_out"), now: NOW });
    expect(result).toMatchObject({ outcome: "applied", kind: "late_check_out", time: "14:00" });
    expect(storedData(db)).toMatchObject({ checkOutTime: "14:00", checkInTime: "15:00" });
    expect(stored(db)).toMatchObject({ ends_at: "2026-10-23T21:00:00.000Z" });
    expect(spies.refreshTurnoverCleaningTimes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ checkOutDate: "2026-10-23" }));
    expect(spies.enqueueOwnerSms.mock.calls[0]![0]).toMatchObject({ body: "PropLane: Late checkout at 2:00 pm is confirmed for Oct 23." });
  });

  it("is idempotent: a replayed webhook applies nothing twice and sends nothing twice", async () => {
    const db = seeded({ others: [otherStay("prev", "2026-10-17", "2026-10-19")] });
    await paidEarly(db);
    const id = stayAddOnChargeId(BLOCK, "early_check_in");
    await applyPaidStayAddOn(db as never, { chargeId: id, now: NOW });
    const again = await applyPaidStayAddOn(db as never, { chargeId: id, now: NOW });
    expect(again).toEqual({ outcome: "ignored", reason: "already_settled" });
    expect(spies.enqueueOwnerSms).toHaveBeenCalledTimes(1);
    expect(spies.emitActionEvent).toHaveBeenCalledTimes(1);
    expect(spies.refreshTurnoverCleaningTimes).toHaveBeenCalledTimes(1);
  });

  it("with no previous guest there is no clean to re-time for an early check-in", async () => {
    const db = seeded();
    await paidEarly(db);
    await applyPaidStayAddOn(db as never, { chargeId: stayAddOnChargeId(BLOCK, "early_check_in"), now: NOW });
    expect(spies.refreshTurnoverCleaningTimes).not.toHaveBeenCalled();
    expect(storedData(db).checkInTime).toBe("12:00");
  });

  it("a payment still clearing (processing) changes nothing", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    const row = chargeRow(db, "early_check_in")!;
    row.status = "processing";
    expect(await applyPaidStayAddOn(db as never, { chargeId: stayAddOnChargeId(BLOCK, "early_check_in"), now: NOW })).toEqual({ outcome: "ignored", reason: "not_paid" });
    expect(storedData(db).checkInTime).toBe("15:00");
    expect(spies.refundPaidHouseholdCharge).not.toHaveBeenCalled();
  });

  it("ignores a charge that is not an add-on", async () => {
    const db = seeded();
    expect(await applyPaidStayAddOn(db as never, { chargeId: "hc_mgr_stay_x_stay_total", now: NOW })).toMatchObject({ outcome: "ignored" });
    expect(await applyPaidStayAddOn(db as never, { chargeId: "hc_rent_2026_10", now: NOW })).toMatchObject({ outcome: "ignored" });
  });
});

describe("paid but no longer honorable: refunded automatically, once", () => {
  const stripe = { paymentIntents: { retrieve: vi.fn() } } as never;

  async function paidThenTaken(db: ReturnType<typeof seeded>) {
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    // between the request and the payment the previous guest was extended past noon
    db.tables.portal_schedule_records!.push(otherStay("prev", "2026-10-17", "2026-10-20"));
  }

  it("refunds through the refund rail on a stable key, records `refunded`, texts the guest, tells the team", async () => {
    const db = seeded();
    await paidThenTaken(db);
    const id = stayAddOnChargeId(BLOCK, "early_check_in");
    const result = await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW });
    expect(result).toMatchObject({ outcome: "refunded", kind: "early_check_in", reason: "previous_guest" });
    expect(spies.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
    expect(spies.refundPaidHouseholdCharge.mock.calls[0]![2]).toMatchObject({
      chargeId: id,
      stripeChargeId: "ch_test_1",
      amountCents: 2500,
      idempotencyKey: stayAddOnRefundKey(id, 2500),
    });
    expect(storedData(db)).toMatchObject({ checkInTime: "15:00" });
    expect(storedData(db).stayDetails.addOns!.early_check_in).toMatchObject({ status: "refunded", refundReason: "previous_guest" });
    expect(chargeRow(db, "early_check_in")!.row_data).toMatchObject({ refundedCents: 2500 });
    expect(spies.enqueueOwnerSms.mock.calls[0]![0]).toMatchObject({
      purpose: "short_stay_add_on_refunded",
      body: "PropLane: Early check-in at 12:00 pm isn't available for Oct 20 anymore, so we refunded $25. Your check-in stays at 3:00 pm.",
    });
    expect(spies.emitActionEvent.mock.calls[0]![1]).toMatchObject({ event: "short_stay_add_on_refunded", domain: "channel_booking" });
    expect(spies.refreshTurnoverCleaningTimes).not.toHaveBeenCalled();
  });

  it("a replayed webhook refunds nothing again and texts nothing again", async () => {
    const db = seeded();
    await paidThenTaken(db);
    const id = stayAddOnChargeId(BLOCK, "early_check_in");
    await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW });
    const again = await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW });
    expect(again).toEqual({ outcome: "ignored", reason: "already_settled" });
    expect(spies.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
    expect(spies.enqueueOwnerSms).toHaveBeenCalledTimes(1);
  });

  it("a crash between the Stripe refund and the stay's record is repaired by the redelivery without asking Stripe again", async () => {
    const db = seeded();
    await paidThenTaken(db);
    const id = stayAddOnChargeId(BLOCK, "early_check_in");
    await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW });
    // the first delivery refunded and wrote the charge row, then died before the stay was marked
    storedData(db).stayDetails.addOns!.early_check_in = { time: "12:00", priceCents: 2500, status: "pending", chargeId: id };
    const redelivered = await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW });
    expect(redelivered).toMatchObject({ outcome: "refunded" });
    // already refunded in full on the charge row: Stripe is not asked a second time
    expect(spies.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
    expect(storedData(db).stayDetails.addOns!.early_check_in).toMatchObject({ status: "refunded" });
  });

  // Review fix, Oct 20. The upsert that records `refundedCents` was awaited without reading `{ error }`, and
  // PostgREST reports a failed write that way. The stay flipped to `refunded` and a replay then answered
  // `already_settled`, while the charge row still read paid with `refundedCents: 0` - so the refund was invisible
  // in Payments and the same money could be refunded again. The refund call is idempotency-keyed, so throwing is
  // safe: Stripe redelivers and the write is retried.
  it("throws when the refund cannot be recorded, so Stripe redelivers instead of losing it", async () => {
    const db = seeded({
      failWrite: (table, mode, payload) =>
        table === "portal_household_charge_records" && mode === "upsert" &&
        (payload as { row_data?: { refundedCents?: number } } | null)?.row_data?.refundedCents === 2500
          ? { code: "57014", message: "statement timeout" }
          : null,
    });
    await paidThenTaken(db);
    const id = stayAddOnChargeId(BLOCK, "early_check_in");
    await expect(applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW })).rejects.toThrow(/was not recorded/);
    expect(spies.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
    // The stay was NOT marked settled, so the redelivery runs the whole thing again.
    expect(storedData(db).stayDetails.addOns!.early_check_in).not.toMatchObject({ status: "refunded" });
  });

  it("the capacity trigger refusing the new time (P4001) is the same refund", async () => {
    const db = seeded({
      // only the paid time change is refused; the guest's own request stamp (still 3:00 pm) is not
      failWrite: (table, _mode, payload) =>
        table === "portal_schedule_records" && (payload as { row_data?: { checkInTime?: string } } | null)?.row_data?.checkInTime === "12:00"
          ? { code: "P4001", message: "capacity" }
          : null,
    });
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    const result = await applyPaidStayAddOn(db as never, { chargeId: stayAddOnChargeId(BLOCK, "early_check_in"), stripe, now: NOW });
    expect(result).toMatchObject({ outcome: "refunded", reason: "slot_taken" });
    expect(spies.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
    expect(storedData(db).checkInTime).toBe("15:00");
  });

  it("paid for a stay that was cancelled meanwhile: refunded, nothing applied", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    stored(db).record_type = "cancelled_room_date_block";
    expect(await applyPaidStayAddOn(db as never, { chargeId: stayAddOnChargeId(BLOCK, "early_check_in"), stripe, now: NOW })).toMatchObject({ outcome: "refunded", reason: "stay_cancelled" });
    expect(spies.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
  });

  it("paid with no matching request on the stay: refunded, the stay's time is never touched", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    delete storedData(db).stayDetails.addOns;
    expect(await applyPaidStayAddOn(db as never, { chargeId: stayAddOnChargeId(BLOCK, "early_check_in"), stripe, now: NOW })).toMatchObject({ outcome: "refunded", reason: "no_request" });
    expect(storedData(db).checkInTime).toBe("15:00");
  });

  it("falls back to the payment intent's charge when the ledger line lags the webhook", async () => {
    const db = seeded();
    await paidThenTaken(db);
    db.tables.ledger_entries = [];
    (stripe as { paymentIntents: { retrieve: ReturnType<typeof vi.fn> } }).paymentIntents.retrieve.mockResolvedValueOnce({ latest_charge: "ch_from_intent" });
    await applyPaidStayAddOn(db as never, { chargeId: stayAddOnChargeId(BLOCK, "early_check_in"), stripe, paymentIntentId: "pi_1", now: NOW });
    expect(spies.refundPaidHouseholdCharge.mock.calls[0]![2]).toMatchObject({ stripeChargeId: "ch_from_intent" });
  });
});

describe("a refund that can never succeed does not wedge the webhook", () => {
  const stripe = { paymentIntents: { retrieve: vi.fn() } } as never;
  const id = stayAddOnChargeId(BLOCK, "early_check_in");

  async function paidThenTaken(db: ReturnType<typeof seeded>) {
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    db.tables.portal_schedule_records!.push(otherStay("prev", "2026-10-17", "2026-10-20"));
  }

  it("a terminal refusal from the refund rail stamps `refund_failed`, tells the host ONCE and returns normally", async () => {
    const db = seeded();
    await paidThenTaken(db);
    spies.refundPaidHouseholdCharge.mockRejectedValue(new spies.ReviewError("This payment was taken before the new payment system; its refund needs review."));
    const result = await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW });
    expect(result).toMatchObject({ outcome: "refund_failed", kind: "early_check_in", chargeId: id });
    expect(storedData(db).stayDetails.addOns!.early_check_in).toMatchObject({ status: "refund_failed" });
    expect(storedData(db).checkInTime).toBe("15:00");
    expect(spies.emitActionEvent).toHaveBeenCalledTimes(1);
    expect(spies.emitActionEvent.mock.calls[0]![1]).toMatchObject({ event: "short_stay_add_on_refund_failed", eventId: `short_stay_add_on_refund_failed:${id}`, domain: "channel_booking" });
    const text = (spies.emitActionEvent.mock.calls[0]![1] as { recipients: Array<{ rendered: { text: string } }> }).recipients[0]!.rendered.text;
    expect(text).toContain("Couldn't refund the $25 early check-in for Priya Natarajan automatically. Refund it from Payments");
    // nothing went back, so the guest is not told it did
    expect(spies.enqueueOwnerSms).not.toHaveBeenCalled();
    expect(chargeRow(db, "early_check_in")!.row_data).not.toHaveProperty("refundedCents");
    // a redelivery changes nothing and does not shout again
    expect(await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW })).toEqual({ outcome: "ignored", reason: "already_settled" });
    expect(spies.emitActionEvent).toHaveBeenCalledTimes(1);
    spies.refundPaidHouseholdCharge.mockResolvedValue({ refundId: "re_1", rail: "destination" });
  });

  it("no Stripe charge to refund against is terminal too (the payment intent had none)", async () => {
    const db = seeded();
    await paidThenTaken(db);
    db.tables.ledger_entries = [];
    (stripe as { paymentIntents: { retrieve: ReturnType<typeof vi.fn> } }).paymentIntents.retrieve.mockResolvedValueOnce({ latest_charge: null });
    const result = await applyPaidStayAddOn(db as never, { chargeId: id, stripe, paymentIntentId: "pi_1", now: NOW });
    expect(result).toMatchObject({ outcome: "refund_failed" });
    expect(spies.refundPaidHouseholdCharge).not.toHaveBeenCalled();
    expect(storedData(db).stayDetails.addOns!.early_check_in).toMatchObject({ status: "refund_failed" });
  });

  it("a rejected Stripe request (invalid_request_error) is terminal; a network failure still throws so Stripe redelivers", async () => {
    const db = seeded();
    await paidThenTaken(db);
    spies.refundPaidHouseholdCharge.mockRejectedValueOnce(Object.assign(new Error("No such charge"), { type: "StripeInvalidRequestError" }));
    expect(await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW })).toMatchObject({ outcome: "refund_failed" });
    const other = seeded();
    await paidThenTaken(other);
    spies.refundPaidHouseholdCharge.mockRejectedValueOnce(Object.assign(new Error("connection reset"), { type: "StripeConnectionError" }));
    await expect(applyPaidStayAddOn(other as never, { chargeId: id, stripe, now: NOW })).rejects.toThrow("connection reset");
    expect(storedData(other).stayDetails.addOns!.early_check_in).toMatchObject({ status: "pending" });
  });

  it("a persistent constraint error (23514) applying the time is a refund; a transient write failure throws", async () => {
    const make = (code: string) =>
      seeded({
        failWrite: (table, _mode, payload) =>
          table === "portal_schedule_records" && (payload as { row_data?: { checkInTime?: string } } | null)?.row_data?.checkInTime === "12:00" ? { code, message: "boom" } : null,
      });
    const rejected = make("23514");
    await ask(rejected, "early_check_in");
    markPaid(rejected, "early_check_in");
    expect(await applyPaidStayAddOn(rejected as never, { chargeId: id, stripe, now: NOW })).toMatchObject({ outcome: "refunded", reason: "write_rejected" });
    const transient = make("57014");
    await ask(transient, "early_check_in");
    markPaid(transient, "early_check_in");
    await expect(applyPaidStayAddOn(transient as never, { chargeId: id, stripe, now: NOW })).rejects.toThrow();
  });

  it("a persistent error recording the refunded record is logged, not thrown", async () => {
    const db = seeded({
      failWrite: (table, _mode, payload) =>
        table === "portal_schedule_records" && (payload as { row_data?: { stayDetails?: { addOns?: { early_check_in?: { status?: string } } } } } | null)?.row_data?.stayDetails?.addOns?.early_check_in?.status === "refunded"
          ? { code: "23514", message: "check" }
          : null,
    });
    await paidThenTaken(db);
    expect(await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW })).toMatchObject({ outcome: "refunded" });
    expect(spies.refundPaidHouseholdCharge).toHaveBeenCalledTimes(1);
  });
});

describe("deadlocks and serialization failures are never a refusal", () => {
  const stripe = { paymentIntents: { retrieve: vi.fn() } } as never;
  const id = stayAddOnChargeId(BLOCK, "early_check_in");

  it("40001 once is retried and the add-on applies; nothing is refunded", async () => {
    let failures = 1;
    const db = seeded({
      failWrite: (table, _mode, payload) => {
        if (table === "portal_schedule_records" && (payload as { row_data?: { checkInTime?: string } } | null)?.row_data?.checkInTime === "12:00" && failures-- > 0) return { code: "40001", message: "serialization" };
        return null;
      },
    });
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    expect(await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW })).toMatchObject({ outcome: "applied" });
    expect(spies.refundPaidHouseholdCharge).not.toHaveBeenCalled();
    expect(storedData(db).checkInTime).toBe("12:00");
  });

  it("a deadlock (40P01) that keeps happening exhausts the retries and THROWS: no refund, the webhook is redelivered", async () => {
    const db = seeded({
      failWrite: (table, _mode, payload) =>
        table === "portal_schedule_records" && (payload as { row_data?: { checkInTime?: string } } | null)?.row_data?.checkInTime === "12:00" ? { code: "40P01", message: "deadlock" } : null,
    });
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    await expect(applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW })).rejects.toThrow();
    expect(spies.refundPaidHouseholdCharge).not.toHaveBeenCalled();
    expect(storedData(db).checkInTime).toBe("15:00");
  });

  it("only P4001 (the capacity trigger) is a refusal", async () => {
    const db = seeded({
      failWrite: (table, _mode, payload) =>
        table === "portal_schedule_records" && (payload as { row_data?: { checkInTime?: string } } | null)?.row_data?.checkInTime === "12:00" ? { code: "P4001", message: "capacity" } : null,
    });
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    expect(await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW })).toMatchObject({ outcome: "refunded", reason: "slot_taken" });
  });
});

describe("a payment that was already refunded never applies the add-on", () => {
  const stripe = { paymentIntents: { retrieve: vi.fn() } } as never;
  const id = stayAddOnChargeId(BLOCK, "early_check_in");

  it("redelivery after a crash between the refund and the stay's record records the refund, even though the slot is free again", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    // the first delivery refunded and wrote the charge row, then died before the stay was marked
    const charge = chargeRow(db, "early_check_in")!.row_data as Record<string, unknown>;
    charge.refundedCents = 2500;
    charge.stayAddOnRefundReason = "previous_guest";
    // ... and the previous guest is gone, so the slot would now quote as available
    const result = await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW });
    expect(result).toMatchObject({ outcome: "refunded", reason: "previous_guest" });
    expect(storedData(db).checkInTime).toBe("15:00");
    expect(storedData(db).stayDetails.addOns!.early_check_in).toMatchObject({ status: "refunded", refundReason: "previous_guest" });
    expect(spies.refundPaidHouseholdCharge).not.toHaveBeenCalled();
    expect(spies.refreshTurnoverCleaningTimes).not.toHaveBeenCalled();
  });

  it("a lost swap while recording it is retried, not ignored", async () => {
    let failures = 1;
    const db = seeded({
      failWrite: (table, _mode, payload) =>
        table === "portal_schedule_records" && (payload as { row_data?: { stayDetails?: { addOns?: { early_check_in?: { status?: string } } } } } | null)?.row_data?.stayDetails?.addOns?.early_check_in?.status === "refunded" && failures-- > 0
          ? { code: "40001", message: "serialization" }
          : null,
    });
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    (chargeRow(db, "early_check_in")!.row_data as Record<string, unknown>).refundedCents = 2500;
    await applyPaidStayAddOn(db as never, { chargeId: id, stripe, now: NOW });
    expect(storedData(db).stayDetails.addOns!.early_check_in).toMatchObject({ status: "refunded" });
  });
});

describe("checkout never starts for an add-on that would be refunded", () => {
  const id = stayAddOnChargeId(BLOCK, "early_check_in");

  it("a second tap after the slot was taken voids the pending charge and clears the record", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    db.tables.portal_schedule_records!.push(otherStay("prev", "2026-10-17", "2026-10-20"));
    spies.createHouseholdChargeCheckout.mockClear();
    const again = await ask(db, "early_check_in");
    expect(again).toMatchObject({ ok: false, status: 409, error: "Early check-in isn't available that day." });
    expect(spies.createHouseholdChargeCheckout).not.toHaveBeenCalled();
    expect(chargeRow(db, "early_check_in")).toMatchObject({ status: "cancelled" });
    expect(storedData(db).stayDetails.addOns).toBeUndefined();
  });

  it("checkStayAddOnPayable passes while available, and voids (with a clear message) once it is not", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    const charge = chargeRow(db, "early_check_in")!.row_data as Record<string, unknown>;
    expect(await checkStayAddOnPayable(db as never, charge, NOW)).toEqual({ ok: true });
    expect(await checkStayAddOnPayable(db as never, { id: "hc_rent", kind: "rent" }, NOW)).toEqual({ ok: true });
    // the guest's check-in time has passed
    const late = new Date("2026-10-20T23:00:00Z");
    expect(await checkStayAddOnPayable(db as never, charge, late)).toMatchObject({ ok: false, retry: false, message: "That time has already passed." });
    expect(chargeRow(db, "early_check_in")).toMatchObject({ status: "cancelled" });
    expect(storedData(db).stayDetails.addOns).toBeUndefined();
  });

  it("an unreadable calendar answers retry and voids nothing", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    const charge = chargeRow(db, "early_check_in")!.row_data as Record<string, unknown>;
    const original = db.from.bind(db);
    (db as { from: typeof db.from }).from = (table: string) => {
      if (table === "external_calendar_connections") {
        const failing = { select: () => failing, eq: () => failing, then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "down" } }) };
        return failing as never;
      }
      return original(table);
    };
    expect(await checkStayAddOnPayable(db as never, charge, NOW)).toMatchObject({ ok: false, retry: true });
    expect(chargeRow(db, "early_check_in")).toMatchObject({ status: "pending" });
  });

  it("once voided, a later request (slot free again) raises the charge afresh and it can be paid", async () => {
    const db = seeded({ others: [otherStay("prev", "2026-10-17", "2026-10-19")] });
    await ask(db, "early_check_in");
    const prev = db.tables.portal_schedule_records!.find((r) => r.id === "prev")!;
    (prev.row_data as Record<string, unknown>).checkOut = "2026-10-20";
    await ask(db, "early_check_in");
    expect(chargeRow(db, "early_check_in")).toMatchObject({ status: "cancelled" });
    (prev.row_data as Record<string, unknown>).checkOut = "2026-10-19";
    const result = await ask(db, "early_check_in");
    expect(result).toMatchObject({ ok: true, status: "pending", chargeId: id });
    expect(chargeRow(db, "early_check_in")).toMatchObject({ status: "pending" });
  });
});

describe("the webhook's one call", () => {
  it("settles only the add-on charges among a payment's ids and rethrows a failure after the others ran", async () => {
    const db = seeded();
    await ask(db, "early_check_in");
    markPaid(db, "early_check_in");
    const results = await settleStayAddOnsForCharges(db as never, { chargeIds: ["hc_rent_oct", stayAddOnChargeId(BLOCK, "early_check_in")] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "applied" });
  });
});
