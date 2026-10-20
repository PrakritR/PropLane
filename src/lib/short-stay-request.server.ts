import "server-only";

/**
 * The shared core for every short-stay row. The anonymous public booking route is retired; a stay
 * is requested only inside the resident portal (`POST /api/resident/stays`,
 * `short-stay/guest-stays.server.ts`) or by SMS (`short-stay/sms-stay-book.server.ts`,
 * `tools/domains/short-stay-sms.ts`). Both call `loadShortStayListing` to re-read the live listing,
 * room and nightly rate, then `createShortStayRows`, so a stay row has one shape:
 * `stayDetails.guests` (the capacity trigger weighs a stay by it), a 24-hour `holdExpiresAt` on a
 * hold, the guest's `residentUserId` and a `source`.
 *
 * It creates what the manager's "Add booking" sheet saves: a `room_date_block` in
 * `portal_schedule_records` with the guest on it. Availability is re-checked against the same
 * occupancy the listing reads; the capacity trigger on `portal_schedule_records` is the last word,
 * and a refusal there is a 409. Notifications are the caller's (`emitShortStayRequestedEvent` is the
 * shared owner/teammate notice).
 */
import { randomUUID } from "node:crypto";
import {
  normalizeStayTime,
  wallInstantIso,
  STAY_ADD_ON_KINDS,
  stayAddOnAvailability,
  type StayAddOnKind,
  type StayAddOnRecord,
  type StayAddOns,
} from "@/lib/bookings/stay-times";
import { loadPropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { ROOM_DATE_BLOCK_RECORD_TYPE, roomDateBlockRecordId } from "@/lib/portal-schedule-record-scope";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { roomAvailabilityForRange } from "@/lib/room-availability-range.server";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { offerFromQuote, withPriceFloor, type StayAddOnOffer } from "@/lib/short-stay/stay-add-ons";
import { StayAddOnReadError, loadRoomOtherStays } from "@/lib/short-stay/stay-add-ons.server";
import {
  GUEST_PORTAL_SHORT_STAY_SOURCE,
  PUBLIC_SHORT_STAY_SOURCE,
  SMS_SHORT_STAY_SOURCE,
  shortStayHoldExpiresAt,
} from "@/lib/short-stay/guest-stays";
import {
  formatShortStayMoney,
  listingOffersShortStay,
  shortStayRangeLabel,
  shortStayRoomNightly,
  shortStayTotal,
} from "@/lib/short-stay-request";

/** The add-on kinds a request body names, deduplicated and filtered to the two real ones. */
export function requestedAddOnKinds(value: unknown): StayAddOnKind[] {
  if (!Array.isArray(value)) return [];
  return STAY_ADD_ON_KINDS.filter((kind) => value.includes(kind));
}

/* ───────────────────── the one core: every short-stay row is written here ───────────────────── */

export type ShortStayListing = {
  propertyId: string;
  ownerId: string;
  propertyLabel: string;
  /** The stored submission as-is: `roomAvailabilityForRange` normalizes it itself and refuses an unreadable one. */
  submission: ManagerListingSubmissionV1;
  room: NonNullable<ManagerListingSubmissionV1["rooms"]>[number];
  roomLabel: string;
  /** Dollars per night. */
  nightly: number;
};

export type LoadShortStayListingResult =
  | { ok: true; listing: ShortStayListing }
  | { ok: false; status: 400 | 404; error: string };

/** The live listing, its room and the nightly rate a short stay books at. Re-read on the server every time. */
export async function loadShortStayListing(
  db: SupabaseClient,
  input: { propertyId: string; roomId: string; guests: number },
): Promise<LoadShortStayListingResult> {
  const { propertyId, roomId, guests } = input;
  const { data: record } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, status, property_data")
    .eq("id", propertyId)
    .is("test_workspace_id", null)
    .maybeSingle();
  const ownerId = String(record?.manager_user_id ?? "").trim();
  if (!record || record.status !== "live" || !ownerId) return { ok: false, status: 404, error: "Listing not found." };
  const property = (record.property_data ?? {}) as { title?: string; buildingName?: string; address?: string; listingSubmission?: unknown };
  const submission = (property.listingSubmission ?? {}) as ManagerListingSubmissionV1;
  if (!listingOffersShortStay(submission)) return { ok: false, status: 400, error: "This listing doesn't take short stays." };
  const rooms = submission.rooms ?? [];
  const roomIndex = rooms.findIndex((candidate) => candidate.id === roomId);
  const room = rooms[roomIndex];
  if (!room) return { ok: false, status: 404, error: "Room not found." };
  if (guests > normalizeRoomOccupancyCapacity(room.occupancyCapacity)) {
    return { ok: false, status: 400, error: "That's more guests than the room sleeps." };
  }
  const nightly = shortStayRoomNightly(room, submission.shortTermDailyCost);
  if (nightly <= 0) return { ok: false, status: 400, error: "This room has no nightly rate." };
  return {
    ok: true,
    listing: {
      propertyId,
      ownerId,
      propertyLabel: (property.buildingName || property.title || property.address || "the house").trim(),
      submission,
      room,
      roomLabel: room.name?.trim() || `Room ${roomIndex + 1}`,
      nightly,
    },
  };
}

export type ShortStayActor = {
  source: typeof PUBLIC_SHORT_STAY_SOURCE | typeof GUEST_PORTAL_SHORT_STAY_SOURCE | typeof SMS_SHORT_STAY_SOURCE;
  name: string;
  phone: string;
  email: string;
  /** The guest's login when there is one (always for the portal route; none for an SMS stay). */
  residentUserId: string | null;
};

export type ShortStayRowRange = { checkIn: string; checkOut: string; nights: number };

export type ShortStayRowResult =
  | {
      ok: true;
      range: ShortStayRowRange;
      status: "hold" | "confirmed";
      total: number;
      /** Null on a dry run: nothing was written. */
      blockId: string | null;
      holdExpiresAt: string | null;
      rowData: Record<string, unknown> | null;
      /** Which paid add-ons these nights could carry (kind, time, price; never why not). */
      addOnOffers: StayAddOnOffer[];
      /** Add-ons the guest asked for that are NOT on the stay (no longer available when it was written). */
      addOnsSkipped: StayAddOnKind[];
    }
  | { ok: false; range: ShortStayRowRange; status: 400 | 409 | 503; error: string };

/**
 * Writes one `room_date_block` per range (or, on `dryRun`, only checks them). Each range is its own
 * stay with its own outcome: one that is taken or refused by the capacity trigger does not stop the
 * others. `status` is the caller's decision (the instant-book rule lives in
 * `short-stay/instant-book.server.ts`); a hold gets `holdExpiresAt` 24 hours out, which the
 * `short-stay-hold-expiry` cron reads. Notifications are the caller's: it knows how many ranges went
 * out and can send one text for them.
 */
export async function createShortStayRows(
  db: SupabaseClient,
  input: {
    actor: ShortStayActor;
    listing: ShortStayListing;
    guests: number;
    ranges: readonly ShortStayRowRange[];
    status: "hold" | "confirmed";
    dryRun?: boolean;
    now?: Date;
    /** "HH:MM" the guest says they will arrive; stored, never acted on. */
    estimatedArrival?: string | null;
    /** Add-ons the guest ticked; each is stored `requested` only when it is available for these exact nights. */
    addOns?: readonly StayAddOnKind[];
  },
): Promise<ShortStayRowResult[]> {
  const { actor, listing, guests, status } = input;
  const nowDate = input.now ?? new Date();
  const results: ShortStayRowResult[] = [];
  // The property's own check-in / check-out times and clock: a stay row is stamped with real instants.
  const { times: stayTimes, timeZone } = await loadPropertyStayClock(db, listing.propertyId);
  for (const range of input.ranges) {
    const availability = await roomAvailabilityForRange(
      { propertyId: listing.propertyId, roomId: listing.room.id, moveIn: range.checkIn, moveOut: range.checkOut },
      { submission: listing.submission, expectedOwnerId: listing.ownerId },
    );
    if (!availability.ok) {
      results.push({ ok: false, range, status: 400, error: "Those dates aren't valid." });
      continue;
    }
    const verdict = availability.rooms[0];
    if (!verdict || verdict.available === null) {
      results.push({ ok: false, range, status: 503, error: "We couldn't check the calendar right now. Try again in a minute." });
      continue;
    }
    if (!verdict.available) {
      results.push({ ok: false, range, status: 409, error: "That room was just booked for those dates." });
      continue;
    }
    const total = shortStayTotal(listing.nightly, range.nights);

    // What the property's add-on rule says about THESE nights, against the room's other stays. An unreadable
    // calendar offers nothing (fail closed); it never blocks the stay itself.
    const newStay = { id: "new-stay", checkIn: range.checkIn, checkOut: range.checkOut, checkInTime: stayTimes.checkInTime, checkOutTime: stayTimes.checkOutTime };
    let addOnOffers: StayAddOnOffer[] = STAY_ADD_ON_KINDS.map((kind) => ({ kind, available: false }));
    let addOnQuotes: Partial<Record<StayAddOnKind, Extract<ReturnType<typeof withPriceFloor>, { available: true }>>> = {};
    try {
      const others = await loadRoomOtherStays(db, { propertyId: listing.propertyId, roomId: listing.room.id, selfId: null, checkIn: range.checkIn, checkOut: range.checkOut, times: stayTimes });
      const quotes = STAY_ADD_ON_KINDS.map((kind) => withPriceFloor(stayAddOnAvailability(kind, { stay: newStay, others, times: stayTimes })));
      addOnOffers = quotes.map(offerFromQuote);
      for (const quote of quotes) if (quote.available) addOnQuotes = { ...addOnQuotes, [quote.kind]: quote };
    } catch (error) {
      if (!(error instanceof StayAddOnReadError)) throw error;
    }
    const askedFor = input.addOns ?? [];
    const addOnsSkipped = askedFor.filter((kind) => !addOnQuotes[kind]);
    if (input.dryRun) {
      results.push({ ok: true, range, status, total, blockId: null, holdExpiresAt: null, rowData: null, addOnOffers, addOnsSkipped });
      continue;
    }
    const nowIso = nowDate.toISOString();
    const requestedAddOns: StayAddOns = {};
    for (const kind of askedFor) {
      const quote = addOnQuotes[kind];
      if (!quote) continue;
      const record: StayAddOnRecord = { time: quote.time, priceCents: quote.priceCents, status: "requested", requestedAt: nowIso };
      requestedAddOns[kind] = record;
    }
    const arrival = normalizeStayTime(input.estimatedArrival);
    const startsAt = wallInstantIso(range.checkIn, stayTimes.checkInTime, timeZone);
    const endsAt = wallInstantIso(range.checkOut, stayTimes.checkOutTime, timeZone);

    const now = nowDate.toISOString();
    const blockId = roomDateBlockRecordId(listing.ownerId, randomUUID());
    const holdExpiresAt = status === "hold" ? shortStayHoldExpiresAt(nowDate) : null;
    const rowData: Record<string, unknown> = {
      id: blockId,
      recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
      propertyId: listing.propertyId,
      roomId: listing.room.id,
      checkIn: range.checkIn,
      checkOut: range.checkOut,
      reason: status === "confirmed" ? "Short-stay confirmed" : "Short-stay request",
      bookingStatus: status,
      rate: listing.nightly,
      rateBasis: "daily",
      quotedNights: range.nights,
      quotedTotal: total,
      guests,
      residentName: actor.name,
      residentPhone: actor.phone,
      ...(actor.email ? { residentEmail: actor.email } : {}),
      ...(actor.residentUserId ? { residentUserId: actor.residentUserId } : {}),
      // The capacity trigger weighs a stay by `stayDetails.guests` (it never reads the top-level
      // `guests`), so a four-guest request on a shared room counted as one before this was written.
      stayDetails: {
        source: actor.source,
        guests,
        ...(holdExpiresAt ? { holdExpiresAt } : { confirmedAt: now }),
        ...(arrival ? { estimatedArrival: arrival } : {}),
        ...(Object.keys(requestedAddOns).length ? { addOns: requestedAddOns } : {}),
      },
      // The dates stay authoritative; the property's standard times ride beside them as real instants.
      checkInTime: stayTimes.checkInTime,
      checkOutTime: stayTimes.checkOutTime,
      createdAt: now,
      startsAt,
      endsAt,
    };
    const { error: insertError } = await db.from("portal_schedule_records").upsert(
      {
        id: blockId,
        manager_user_id: listing.ownerId,
        property_id: listing.propertyId,
        record_type: ROOM_DATE_BLOCK_RECORD_TYPE,
        starts_at: rowData.startsAt,
        ends_at: rowData.endsAt,
        row_data: rowData,
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (insertError) {
      // The capacity trigger refused the last bed to a concurrent write.
      const code = String((insertError as { code?: string }).code ?? "");
      if (["P4001", "40001", "40P01"].includes(code)) {
        results.push({ ok: false, range, status: 409, error: "That room was just booked for those dates." });
      } else {
        results.push({ ok: false, range, status: 503, error: "We couldn't save your request. Try again in a minute." });
      }
      continue;
    }
    results.push({ ok: true, range, status, total, blockId, holdExpiresAt, rowData, addOnOffers, addOnsSkipped });
  }
  return results;
}

/** `channel_booking` / `short_stay_requested` to the owner and teammates (the notice spine). */
export async function emitShortStayRequestedEvent(
  db: SupabaseClient,
  input: {
    ownerId: string;
    ownerEmail: string;
    ownerName: string;
    propertyId: string;
    roomId: string;
    blockId: string;
    propertyLabel: string;
    roomLabel: string;
    guestName: string;
    guests: number;
    checkIn: string;
    checkOut: string;
    nights: number;
    total: number;
    /** Said in the notice when the guest booked from their portal rather than by text. */
    headline?: string;
  },
): Promise<void> {
  if (!input.ownerEmail) return;
  const stayLabel = `${shortStayRangeLabel(input.checkIn, input.checkOut)} (${input.nights} ${input.nights === 1 ? "night" : "nights"})`;
  const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/bookings/${encodeURIComponent(`block:${input.blockId}`)}`;
  const headline = input.headline ?? "Short-stay request";
  const text = [headline, input.propertyLabel, input.roomLabel, stayLabel, `${input.guestName} · ${input.guests} ${input.guests === 1 ? "guest" : "guests"}`, formatShortStayMoney(input.total)].join(" · ");
  await emitActionEvent(db, {
    eventId: `short_stay_requested:${input.blockId}`,
    domain: "channel_booking",
    event: "short_stay_requested",
    managerUserId: input.ownerId,
    entityId: input.blockId,
    category: "tours",
    senderUserId: input.ownerId,
    senderEmail: input.ownerEmail,
    senderName: input.ownerName || undefined,
    payload: { propertyId: input.propertyId, roomId: input.roomId, blockId: input.blockId, start: input.checkIn, end: input.checkOut, nights: input.nights, guests: input.guests },
    templateContext: { propertyTitle: input.propertyLabel, roomLabel: input.roomLabel, stayLabel, url },
    recipients: [{ audience: "manager", userId: input.ownerId, rendered: { subject: headline, text: `${text}\n\n${url}`, smsText: `${text}\n${url}` } }],
  }).catch(() => undefined);
}
