import "server-only";

/**
 * Paid early check-in / late checkout for a guest's own short stay (bookings-times-1018, contract C).
 *
 * The money rules, in one place:
 * - Identity is the session. `loadGuestStayForAddOns` finds a stay only when `row_data.residentUserId` is
 *   the signed-in user; no body field names who is asking.
 * - The price is the property's stored `listingSubmission.stayTimes` (`stayAddOnAvailability`), read here,
 *   never the request. An add-on priced under the checkout floor is not offered at all.
 * - Availability is decided by `stayAddOnAvailability` against the room's other live stays, at the REQUEST
 *   (here) and again at PAYMENT (`stay-add-on-settlement.server.ts`). A refused request is a 409.
 * - One add-on per kind per stay: the stored record is swapped with a compare-and-swap on `updated_at`, and
 *   the charge id is deterministic (`hc_mgr_stay_<slug>_<kind>`), so a double tap raises one charge.
 * - The charge is a manager-side one-off (`hc_mgr_` prefix, kind `other_cost`, so it books as other income)
 *   carrying `guestStayBlockId` + `stayAddOn`, NEVER `shortStayBookingId` (that field settles a legacy
 *   pay-to-hold booking in the Stripe webhook and would mint a lease). Both resident keys are the guest's
 *   LOGIN, as for the `stay_total`.
 * - A hold only records the request (`requested`); the charge is raised when the host confirms.
 *
 * Applying a PAID add-on (and refunding one that can no longer be honored) is `stay-add-on-settlement.server.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeStayTime,
  resolveStayTimes,
  stayAddOnAvailability,
  stayAddOnLabel,
  wallInstantIso,
  STAY_ADD_ON_KINDS,
  type PropertyStayTimes,
  type StayAddOnKind,
  type StayAddOnRecord,
  type StayAddOns,
  type TimedStay,
} from "@/lib/bookings/stay-times";
import { loadPropertyStayClock, type PropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import type { HouseholdCharge } from "@/lib/household-charges";
import { upsertManagerCharges } from "@/lib/household-charges.server";
import { bestEffortFailed } from "@/lib/observability/best-effort";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { addRangeDays } from "@/lib/room-availability-range";
import { isShortStayRequestSource } from "@/lib/short-stay/guest-stays";
import {
  STAY_ADD_ON_LINK_PATH,
  offerFromQuote,
  readStayAddOns,
  stayAddOnAmountLabel,
  stayAddOnChargeId,
  stayAddOnChargeTitle,
  stayAddOnUnavailableText,
  withPriceFloor,
  type StayAddOnQuote,
  type StayAddOnQuoteRow,
} from "@/lib/short-stay/stay-add-ons";
import { guestChargeIdentity } from "@/lib/short-stay/stay-charge.server";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The room's other stays could not be read: nothing is offered and nothing is charged. */
export class StayAddOnReadError extends Error {
  constructor(message = "We couldn't check the calendar right now.") {
    super(message);
    this.name = "StayAddOnReadError";
  }
}

/* ───────────────────────── the room's other stays ───────────────────────── */

type StayRowTimes = {
  checkInTime?: unknown;
  checkOutTime?: unknown;
  stayDetails?: unknown;
};

/** A stored stay's own wall times: explicit, else the legacy sheet field, else the property default. */
export function storedStayTimes(row: StayRowTimes, times: PropertyStayTimes): { checkInTime: string; checkOutTime: string } {
  const details = asRecord(row.stayDetails);
  return resolveStayTimes(
    {
      checkInTime: typeof row.checkInTime === "string" ? row.checkInTime : null,
      checkOutTime: typeof row.checkOutTime === "string" ? row.checkOutTime : null,
      legacyEarlyCheckIn: typeof details.earlyCheckIn === "string" ? details.earlyCheckIn : null,
      legacyLateCheckOut: typeof details.lateCheckOut === "string" ? details.lateCheckOut : null,
    },
    times,
  );
}

/**
 * The other live stays on one room, as timed stays. INCLUDED: the room's `room_date_block`s (a hold counts,
 * a cancelled one does not; a whole-property block with no room counts for every room) with their own
 * times, and the room's imported channel ranges (Airbnb, Booking.com...) on the property's default times -
 * a host's own closure is skipped, because PropLane's own export echoes back as one. NOT INCLUDED: long-term
 * residents' lease dates (the date-level availability check and the capacity trigger still cover overlap).
 * A read that fails throws `StayAddOnReadError`: an unreadable calendar offers nothing.
 */
export async function loadRoomOtherStays(
  db: SupabaseClient,
  args: { propertyId: string; roomId: string; selfId: string | null; checkIn: string; checkOut: string; times: PropertyStayTimes },
): Promise<TimedStay[]> {
  const { propertyId, roomId, times } = args;
  const windowStart = `${addRangeDays(args.checkIn, -3)}T00:00:00`;
  const windowEnd = addRangeDays(args.checkOut, 3);
  const others: TimedStay[] = [];

  const { data: blocks, error: blockError } = await db
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("property_id", propertyId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
    .gte("ends_at", windowStart)
    .limit(500);
  if (blockError) throw new StayAddOnReadError();
  for (const block of (blocks ?? []) as Array<{ id: unknown; row_data: unknown }>) {
    const id = String(block.id ?? "");
    if (!id || id === args.selfId) continue;
    const row = asRecord(block.row_data);
    if (row.bookingStatus === "cancelled") continue;
    const rowRoom = String(row.roomId ?? "").trim();
    if (rowRoom && rowRoom !== roomId) continue;
    const checkIn = String(row.checkIn ?? "");
    const checkOut = String(row.checkOut ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || checkOut <= checkIn) continue;
    if (checkIn >= windowEnd) continue;
    others.push({ id, checkIn, checkOut, ...storedStayTimes(row, times) });
  }

  const { data: connections, error: connectionError } = await db
    .from("external_calendar_connections")
    .select("imported_ranges")
    .eq("property_id", propertyId)
    .eq("room_id", roomId);
  if (connectionError) throw new StayAddOnReadError();
  let index = 0;
  for (const connection of (connections ?? []) as Array<{ imported_ranges: unknown }>) {
    for (const raw of Array.isArray(connection.imported_ranges) ? connection.imported_ranges : []) {
      const range = asRecord(raw) as { start?: unknown; end?: unknown; hostBlock?: boolean; summary?: string | null };
      if (isHostBlockRange(range)) continue;
      const start = String(range.start ?? "").slice(0, 10);
      const lastNight = String(range.end ?? "").slice(0, 10) || start;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(lastNight)) continue;
      // An imported range's `end` is the last occupied night (iCal DTEND is converted to inclusive), so the
      // channel guest checks out the next morning.
      others.push({ id: `imported:${index++}`, checkIn: start, checkOut: addRangeDays(lastNight, 1), checkInTime: times.checkInTime, checkOutTime: times.checkOutTime });
    }
  }
  return others;
}

/* ───────────────────────── the stay, as the add-on code needs it ───────────────────────── */

export type StayAddOnContext = {
  blockId: string;
  ownerId: string;
  propertyId: string;
  roomId: string;
  recordType: string;
  /** `confirmed` raises a charge now; `hold` only records the request. */
  bookingStatus: "confirmed" | "hold";
  row: Record<string, unknown>;
  updatedAt: string | null;
  /** The stay with its current wall times (an applied add-on has already moved them). */
  stay: TimedStay;
  others: TimedStay[];
  clock: PropertyStayClock;
  addOns: StayAddOns;
};

type BlockRecord = { id: string; manager_user_id: string | null; property_id: string | null; record_type: string; row_data: unknown; updated_at: string | null };

async function readBlock(db: SupabaseClient, blockId: string): Promise<BlockRecord | null> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, record_type, row_data, updated_at")
    .eq("id", blockId)
    .maybeSingle();
  if (error) throw new StayAddOnReadError();
  return (data as BlockRecord | null) ?? null;
}

export async function contextFromBlock(db: SupabaseClient, record: BlockRecord): Promise<StayAddOnContext | null> {
  const row = asRecord(record.row_data);
  const details = asRecord(row.stayDetails);
  if (record.record_type !== ROOM_DATE_BLOCK_RECORD_TYPE || !isShortStayRequestSource(details.source)) return null;
  const bookingStatus = row.bookingStatus;
  if (bookingStatus !== "confirmed" && bookingStatus !== "hold") return null;
  const checkIn = String(row.checkIn ?? "");
  const checkOut = String(row.checkOut ?? "");
  const roomId = String(row.roomId ?? "").trim();
  const propertyId = String(record.property_id ?? row.propertyId ?? "").trim();
  const ownerId = String(record.manager_user_id ?? "").trim();
  if (!roomId || !propertyId || !ownerId || !checkIn || !checkOut || checkOut <= checkIn) return null;
  const clock = await loadPropertyStayClock(db, propertyId);
  const own = storedStayTimes(row, clock.times);
  const others = await loadRoomOtherStays(db, { propertyId, roomId, selfId: record.id, checkIn, checkOut, times: clock.times });
  return {
    blockId: record.id,
    ownerId,
    propertyId,
    roomId,
    recordType: record.record_type,
    bookingStatus,
    row,
    updatedAt: record.updated_at ?? null,
    stay: { id: record.id, checkIn, checkOut, ...own },
    others,
    clock,
    addOns: readStayAddOns(details),
  };
}

/**
 * The confirmed or hold short-stay block whose `residentUserId` is this user, else null. The user id is the
 * session's; a block that belongs to anyone else answers exactly like one that does not exist.
 */
export async function loadGuestStayForAddOns(db: SupabaseClient, input: { blockId: string; userId: string }): Promise<StayAddOnContext | null> {
  const userId = input.userId.trim();
  const blockId = input.blockId.trim();
  if (!userId || !blockId) return null;
  const record = await readBlock(db, blockId);
  if (!record || asRecord(record.row_data).residentUserId !== userId) return null;
  return contextFromBlock(db, record);
}

/** The same stay without an identity filter: only the payment-time settlement (which cross-checks the charge's login) and the confirm hook use it. */
export async function loadStayForAddOnsById(db: SupabaseClient, blockId: string): Promise<StayAddOnContext | null> {
  const record = await readBlock(db, blockId.trim());
  return record ? contextFromBlock(db, record) : null;
}

/* ───────────────────────── availability ───────────────────────── */

/**
 * One add-on kind's answer RIGHT NOW. Beyond `stayAddOnAvailability` (the rule): an early check-in is
 * pointless once the standard check-in has passed, and a late checkout once the standard checkout has.
 */
export function quoteStayAddOn(ctx: Pick<StayAddOnContext, "stay" | "others" | "clock">, kind: StayAddOnKind, options: { requestedTime?: string | null; now?: Date } = {}): StayAddOnQuote {
  const now = (options.now ?? new Date()).getTime();
  const { stay, clock } = ctx;
  if (now >= Date.parse(wallInstantIso(stay.checkOut, stay.checkOutTime, clock.timeZone))) {
    return { available: false, kind, reason: "stay_over" };
  }
  if (kind === "early_check_in" && now >= Date.parse(wallInstantIso(stay.checkIn, stay.checkInTime, clock.timeZone))) {
    return { available: false, kind, reason: "stay_started" };
  }
  return withPriceFloor(
    stayAddOnAvailability(kind, { stay, others: ctx.others, times: clock.times, requestedTime: options.requestedTime ?? null }),
  );
}

export function quoteStayAddOns(ctx: StayAddOnContext, options: { now?: Date; requested?: Partial<Record<StayAddOnKind, string | null>> } = {}): StayAddOnQuoteRow[] {
  return STAY_ADD_ON_KINDS.map((kind) => ({
    kind,
    label: stayAddOnLabel(kind),
    offer: offerFromQuote(quoteStayAddOn(ctx, kind, { requestedTime: options.requested?.[kind] ?? null, now: options.now })),
    record: ctx.addOns[kind] ?? null,
  }));
}

/* ───────────────────────── writing the stored record ───────────────────────── */

/** The capacity trigger said no: the new time cannot be honored. */
const REFUSED_CODE = "P4001";
/** A concurrent write beat this one (serialization failure, deadlock): re-read and decide again, NEVER treat as a refusal. */
const LOST_CODES = new Set(["40001", "40P01"]);

/** A constraint or data error: the same write will fail the same way every time (class 22 / 23). */
function isPersistentWriteError(code: string): boolean {
  return /^2[23]/.test(code);
}

export type SwapResult = "ok" | "lost" | "refused" | "rejected" | "failed";

/**
 * Compare-and-swap on the row's `updated_at`: the write only lands when nothing else touched the row since
 * it was read. `lost` = someone else wrote first, or a serialization failure / deadlock (re-read and decide
 * again), `refused` = the capacity trigger said no (P4001), `rejected` = a persistent constraint error that
 * retrying never fixes, `failed` = any other (transient) database error.
 */
export async function swapStayRow(
  db: SupabaseClient,
  ctx: Pick<StayAddOnContext, "blockId" | "updatedAt">,
  update: { row_data: Record<string, unknown>; starts_at?: string; ends_at?: string },
  now: string,
): Promise<SwapResult> {
  let query = db
    .from("portal_schedule_records")
    .update({ ...update, updated_at: now })
    .eq("id", ctx.blockId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE);
  query = ctx.updatedAt ? query.eq("updated_at", ctx.updatedAt) : query.is("updated_at", null);
  const { data, error } = await query.select("id");
  if (error) {
    const code = String((error as { code?: string }).code ?? "");
    if (code === REFUSED_CODE) return "refused";
    if (LOST_CODES.has(code)) return "lost";
    return isPersistentWriteError(code) ? "rejected" : "failed";
  }
  return Array.isArray(data) && data.length > 0 ? "ok" : "lost";
}

/** `row_data` with one add-on record replaced (or removed with `null`). */
export function withAddOnRecord(row: Record<string, unknown>, kind: StayAddOnKind, record: StayAddOnRecord | null): Record<string, unknown> {
  const { addOns: priorAddOns, ...details } = asRecord(row.stayDetails);
  const addOns: Record<string, unknown> = { ...asRecord(priorAddOns) };
  if (record) addOns[kind] = record;
  else delete addOns[kind];
  return { ...row, stayDetails: { ...details, ...(Object.keys(addOns).length ? { addOns } : {}) } };
}

/* ───────────────────────── the charge ───────────────────────── */

export type EnsureAddOnChargeResult =
  | { ok: true; created: boolean; chargeId: string; residentEmail: string }
  | { ok: false; reason: "no_guest" | "write_failed" | "mismatch" };

/**
 * Raises the add-on's household charge, idempotent on its deterministic id: a second call finds the row and
 * writes nothing, so a paid or part-paid charge is never overwritten. Both resident keys are the guest's
 * login (see `ensureGuestStayCharge`).
 */
export async function ensureStayAddOnCharge(
  db: SupabaseClient,
  input: { ctx: Pick<StayAddOnContext, "blockId" | "ownerId" | "propertyId" | "row">; kind: StayAddOnKind; record: Pick<StayAddOnRecord, "time" | "priceCents">; propertyLabel: string },
): Promise<EnsureAddOnChargeResult> {
  const { ctx, kind, record } = input;
  const identity = await guestChargeIdentity(db, ctx.row);
  if (!identity) {
    bestEffortFailed("stay add-on charge", { blockId: ctx.blockId, kind, reason: "no_guest" })(new Error("no_guest"));
    return { ok: false, reason: "no_guest" };
  }
  const chargeId = stayAddOnChargeId(ctx.blockId, kind);
  const { data: existing } = await db.from("portal_household_charge_records").select("id, status, row_data").eq("id", chargeId).maybeSingle();
  // A voided (cancelled) charge is re-raised afresh below; anything else under the id is left exactly as it is.
  if (existing && existing.status !== "cancelled") {
    const stored = asRecord(existing.row_data);
    // The id is derived from the block and the kind, so a row under it that names anything else is not ours to pay.
    if (stored.guestStayBlockId !== ctx.blockId || stored.stayAddOn !== kind || stored.residentUserId !== identity.residentUserId) {
      return { ok: false, reason: "mismatch" };
    }
    return { ok: true, created: false, chargeId, residentEmail: identity.residentEmail };
  }
  const now = new Date().toISOString();
  const label = stayAddOnAmountLabel(record.priceCents);
  const charge: HouseholdCharge & { guestStayBlockId: string; stayAddOn: StayAddOnKind; stayAddOnTime: string; stayAddOnPriceCents: number } = {
    id: chargeId,
    createdAt: now,
    residentEmail: identity.residentEmail,
    residentName: typeof ctx.row.residentName === "string" && ctx.row.residentName.trim() ? ctx.row.residentName.trim() : "Guest",
    residentUserId: identity.residentUserId,
    propertyId: ctx.propertyId,
    propertyLabel: input.propertyLabel,
    managerUserId: ctx.ownerId,
    // `other_cost` books as other income. A new kind would ripple through every exhaustive switch; the
    // `stayAddOn` field is what marks this charge for the settlement.
    kind: "other_cost",
    title: stayAddOnChargeTitle(kind, record.time),
    amountLabel: label,
    balanceLabel: label,
    status: "pending",
    blocksLeaseUntilPaid: false,
    residentVisibleAt: now,
    guestStayBlockId: ctx.blockId,
    stayAddOn: kind,
    stayAddOnTime: record.time,
    stayAddOnPriceCents: record.priceCents,
  };
  try {
    await upsertManagerCharges(db, ctx.ownerId, [charge as unknown as Record<string, unknown>]);
  } catch {
    bestEffortFailed("stay add-on charge", { blockId: ctx.blockId, kind, reason: "write_failed" })(new Error("write_failed"));
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, created: true, chargeId, residentEmail: identity.residentEmail };
}

/* ───────────────────────── the guest asks ───────────────────────── */

export type RequestStayAddOnResult =
  | {
      ok: true;
      /** `pending` = a charge is waiting to be paid; `requested` = a hold, the charge comes when the host confirms. */
      status: "pending" | "requested";
      kind: StayAddOnKind;
      time: string;
      priceCents: number;
      chargeId: string | null;
      /** Stripe's hosted page when one could be made; null when the guest should pay from Payments. */
      checkoutUrl: string | null;
      /** Where to pay when there is no hosted page. */
      paymentsPath: string | null;
    }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

const BAD_AVAILABILITY_MESSAGE: Record<string, string> = {
  not_priced: "This add-on isn't offered for this home.",
  stay_started: "That time has already passed.",
  stay_over: "This stay is over.",
};

function unavailableMessage(kind: StayAddOnKind, reason: string): string {
  return BAD_AVAILABILITY_MESSAGE[reason] ?? stayAddOnUnavailableText(kind);
}

async function propertyLabelOf(db: SupabaseClient, propertyId: string): Promise<string> {
  const { data } = await db.from("manager_property_records").select("property_data").eq("id", propertyId).maybeSingle();
  const property = asRecord(data?.property_data) as { title?: string; buildingName?: string; address?: string };
  return String(property.buildingName || property.title || property.address || "the house").trim();
}

/**
 * The guest taps Add. Everything is re-derived here: the stay is the session's, the price and the time
 * window are the property's, availability is checked now. Returns the charge to pay and a checkout link.
 */
export async function requestStayAddOn(
  db: SupabaseClient,
  input: { blockId: string; userId: string; kind: unknown; time?: unknown; appOrigin: string; now?: Date },
): Promise<RequestStayAddOnResult> {
  const kind = input.kind;
  if (typeof kind !== "string" || !(STAY_ADD_ON_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, status: 400, error: "Choose early check-in or late checkout." };
  }
  const addOnKind = kind as StayAddOnKind;
  const requestedTime = input.time === undefined || input.time === null || input.time === "" ? null : normalizeStayTime(input.time);
  if (input.time !== undefined && input.time !== null && input.time !== "" && !requestedTime) {
    return { ok: false, status: 400, error: "That time doesn't look right." };
  }
  const now = input.now ?? new Date();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let ctx: StayAddOnContext | null;
    try {
      ctx = await loadGuestStayForAddOns(db, { blockId: input.blockId, userId: input.userId });
    } catch {
      return { ok: false, status: 503, error: "We couldn't check the calendar right now. Try again in a minute." };
    }
    if (!ctx) return { ok: false, status: 404, error: "Stay not found." };

    const existing = ctx.addOns[addOnKind];
    if (existing?.status === "paid") return { ok: false, status: 409, error: `${stayAddOnLabel(addOnKind)} is already on this stay.` };
    if (existing?.status === "refunded" || existing?.status === "refund_failed") {
      return { ok: false, status: 409, error: `${stayAddOnLabel(addOnKind)} was refunded for this stay. Message the host to ask again.` };
    }
    if (existing?.status === "requested" && ctx.bookingStatus === "hold") {
      return { ok: true, status: "requested", kind: addOnKind, time: existing.time, priceCents: existing.priceCents, chargeId: null, checkoutUrl: null, paymentsPath: null };
    }

    let record: StayAddOnRecord;
    if (existing?.status === "pending" && ctx.bookingStatus === "confirmed" && existing.chargeId === stayAddOnChargeId(ctx.blockId, addOnKind)) {
      // A second tap: the same charge, the same time. Nothing new is stamped, but it is still checked now.
      const again = quoteStayAddOn(ctx, addOnKind, { requestedTime: existing.time, now });
      if (!again.available) {
        // No paying for something the payment would auto-refund: the pending charge is voided now.
        await voidUnpayableStayAddOn(db, ctx, addOnKind, now);
        return { ok: false, status: 409, error: unavailableMessage(addOnKind, again.reason) };
      }
      record = existing;
    } else {
      const quote = quoteStayAddOn(ctx, addOnKind, { requestedTime, now });
      if (!quote.available) return { ok: false, status: 409, error: unavailableMessage(addOnKind, quote.reason) };
      record = {
        time: quote.time,
        priceCents: quote.priceCents,
        status: ctx.bookingStatus === "hold" ? "requested" : "pending",
        ...(ctx.bookingStatus === "hold" ? {} : { chargeId: stayAddOnChargeId(ctx.blockId, addOnKind) }),
        requestedAt: now.toISOString(),
      };
      const swapped = await swapStayRow(db, ctx, { row_data: withAddOnRecord(ctx.row, addOnKind, record) }, now.toISOString());
      if (swapped === "lost") continue;
      if (swapped !== "ok") return { ok: false, status: 503, error: "We couldn't save that. Try again in a minute." };
      if (ctx.bookingStatus === "hold") {
        return { ok: true, status: "requested", kind: addOnKind, time: record.time, priceCents: record.priceCents, chargeId: null, checkoutUrl: null, paymentsPath: null };
      }
    }

    const charge = await ensureStayAddOnCharge(db, {
      ctx,
      kind: addOnKind,
      record,
      propertyLabel: await propertyLabelOf(db, ctx.propertyId),
    });
    if (!charge.ok) return { ok: false, status: 503, error: "We couldn't set up that payment. Try again in a minute." };

    const opened = await openCheckout(db, { userId: input.userId, email: charge.residentEmail, chargeId: charge.chargeId, appOrigin: input.appOrigin });
    if (opened.unavailable) return { ok: false, status: 409, error: opened.unavailable };
    const checkoutUrl = opened.url;
    return {
      ok: true,
      status: "pending",
      kind: addOnKind,
      time: record.time,
      priceCents: record.priceCents,
      chargeId: charge.chargeId,
      checkoutUrl,
      paymentsPath: checkoutUrl ? null : "/resident/payments",
    };
  }
  return { ok: false, status: 409, error: "This stay was just changed. Try again." };
}

/** Stripe's hosted card page for the charge, or null when checkout cannot start (the guest pays from Payments). `unavailable` is set when the add-on can no longer be honored (the charge was voided). */
async function openCheckout(db: SupabaseClient, input: { userId: string; email: string; chargeId: string; appOrigin: string }): Promise<{ url: string | null; unavailable: string | null }> {
  try {
    const { createHouseholdChargeCheckout } = await import("@/lib/stripe-household-charge-checkout.server");
    const result = await createHouseholdChargeCheckout(db, {
      userId: input.userId,
      userEmail: input.email,
      chargeIds: [input.chargeId],
      mode: "hosted",
      paymentMethod: "card",
      appOrigin: input.appOrigin,
      returnPath: STAY_ADD_ON_LINK_PATH,
    });
    if (!result.ok && result.code === STAY_ADD_ON_UNAVAILABLE_CODE) return { url: null, unavailable: result.error };
    return { url: result.ok && result.mode === "hosted" ? result.url : null, unavailable: null };
  } catch {
    return { url: null, unavailable: null };
  }
}

/* ───────────────────────── checkout re-check: no paying for what would be refunded ───────────────────────── */

export const STAY_ADD_ON_UNAVAILABLE_CODE = "STAY_ADD_ON_UNAVAILABLE";

/**
 * Voids a pending add-on charge that can no longer be honored: the charge becomes `cancelled` (checkout refuses
 * anything not pending) and the stay's pending record is removed so nothing can pay it. A later request, when
 * the slot is free again, raises the charge afresh (`ensureStayAddOnCharge` re-opens a cancelled one).
 */
export async function voidUnpayableStayAddOn(
  db: SupabaseClient,
  ctx: Pick<StayAddOnContext, "blockId" | "ownerId">,
  kind: StayAddOnKind,
  now: Date = new Date(),
): Promise<void> {
  const chargeId = stayAddOnChargeId(ctx.blockId, kind);
  const nowIso = now.toISOString();
  const { data: row } = await db.from("portal_household_charge_records").select("id, manager_user_id, status, row_data").eq("id", chargeId).maybeSingle();
  if (row && row.status === "pending") {
    // Through the one charge writer, so the ledger's AR line and the transition follow the cancel.
    await upsertManagerCharges(db, ctx.ownerId || String(row.manager_user_id ?? ""), [
      { ...asRecord(row.row_data), status: "cancelled", stayAddOnVoidedAt: nowIso },
    ]);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const block = await readBlock(db, ctx.blockId);
    if (!block || block.record_type !== ROOM_DATE_BLOCK_RECORD_TYPE) return;
    const rowData = asRecord(block.row_data);
    const record = readStayAddOns(rowData.stayDetails)[kind];
    if (!record || record.status !== "pending" || record.chargeId !== chargeId) return;
    const swapped = await swapStayRow(db, { blockId: block.id, updatedAt: block.updated_at ?? null }, { row_data: withAddOnRecord(rowData, kind, null) }, nowIso);
    if (swapped !== "lost") return;
  }
}

/**
 * Called by checkout for every charge carrying `stayAddOn`, BEFORE a Stripe session exists. Re-runs the quote
 * against the room now; when the add-on can no longer be honored (stay started or over, slot taken, stay gone)
 * the charge is voided and the guest gets a clear error. An unreadable calendar does not void: it answers
 * `retry` (a 503 for the caller) and nothing is created.
 */
export async function checkStayAddOnPayable(
  db: SupabaseClient,
  charge: Record<string, unknown>,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; retry: boolean; message: string }> {
  const kind = charge.stayAddOn;
  if (typeof kind !== "string" || !(STAY_ADD_ON_KINDS as readonly string[]).includes(kind)) return { ok: true };
  const addOnKind = kind as StayAddOnKind;
  const blockId = typeof charge.guestStayBlockId === "string" ? charge.guestStayBlockId.trim() : "";
  if (!blockId || stayAddOnChargeId(blockId, addOnKind) !== String(charge.id ?? "")) {
    return { ok: false, retry: false, message: "This add-on can't be paid." };
  }
  let ctx: StayAddOnContext | null;
  try {
    ctx = await loadStayForAddOnsById(db, blockId);
  } catch {
    return { ok: false, retry: true, message: "We couldn't check the calendar right now. Try again in a minute." };
  }
  const record = ctx?.addOns[addOnKind];
  const time = record?.time ?? (typeof charge.stayAddOnTime === "string" ? charge.stayAddOnTime : null);
  const quote = ctx && ctx.bookingStatus === "confirmed" && record?.status === "pending" && record.chargeId === charge.id ? quoteStayAddOn(ctx, addOnKind, { requestedTime: time, now }) : null;
  if (ctx && quote?.available) return { ok: true };
  await voidUnpayableStayAddOn(db, { blockId, ownerId: ctx?.ownerId ?? String(charge.managerUserId ?? "") }, addOnKind, now);
  return { ok: false, retry: false, message: quote && !quote.available ? unavailableMessage(addOnKind, quote.reason) : stayAddOnUnavailableText(addOnKind) };
}

/* ───────────────────────── the host confirms ───────────────────────── */

/**
 * Called wherever a stay becomes `confirmed` (the host's Approve, an instant confirm). Each `requested`
 * add-on is checked again: still available -> `pending` and its charge is raised; no longer available ->
 * dropped, with nothing charged. Idempotent (the charge id is deterministic) and best-effort: the stay is
 * already confirmed and this never undoes it.
 */
export async function raiseRequestedStayAddOnCharges(db: SupabaseClient, input: { blockId: string; now?: Date }): Promise<{ raised: StayAddOnKind[]; dropped: StayAddOnKind[] }> {
  const raised: StayAddOnKind[] = [];
  const dropped: StayAddOnKind[] = [];
  const now = input.now ?? new Date();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ctx = await loadStayForAddOnsById(db, input.blockId);
      if (!ctx || ctx.bookingStatus !== "confirmed") return { raised, dropped };
      const requested = STAY_ADD_ON_KINDS.filter((kind) => ctx.addOns[kind]?.status === "requested");
      if (requested.length === 0) return { raised, dropped };
      let nextRow = ctx.row;
      const pendingNow: Array<{ kind: StayAddOnKind; record: StayAddOnRecord }> = [];
      const droppedNow: StayAddOnKind[] = [];
      for (const kind of requested) {
        const wanted = ctx.addOns[kind]!;
        const quote = quoteStayAddOn(ctx, kind, { requestedTime: wanted.time, now });
        if (!quote.available) {
          droppedNow.push(kind);
          nextRow = withAddOnRecord(nextRow, kind, null);
          continue;
        }
        const record: StayAddOnRecord = { ...wanted, time: quote.time, priceCents: quote.priceCents, status: "pending", chargeId: stayAddOnChargeId(ctx.blockId, kind) };
        pendingNow.push({ kind, record });
        nextRow = withAddOnRecord(nextRow, kind, record);
      }
      const swapped = await swapStayRow(db, ctx, { row_data: nextRow }, now.toISOString());
      if (swapped === "lost") continue;
      if (swapped !== "ok") return { raised, dropped };
      dropped.push(...droppedNow);
      const propertyLabel = pendingNow.length ? await propertyLabelOf(db, ctx.propertyId) : "";
      for (const { kind, record } of pendingNow) {
        const charge = await ensureStayAddOnCharge(db, { ctx, kind, record, propertyLabel });
        if (charge.ok) raised.push(kind);
      }
      return { raised, dropped };
    }
  } catch (error) {
    bestEffortFailed("raise requested stay add-ons", { blockId: input.blockId })(error);
  }
  return { raised, dropped };
}
