import "server-only";

/**
 * A signed-in guest's own short stays: `GET /api/resident/stays` lists them, `POST` books one or
 * several date ranges (`{propertyId, roomId, ranges:[{checkIn,checkOut}], guests}`).
 *
 * Identity comes from the session, never the body: the guest's name, mobile number and login address are
 * read from their profile, and every row is stamped `residentUserId`. Each range is its own stay with its
 * own outcome (confirmed, pending, unavailable), written by the same core the public card uses
 * (`createShortStayRows`). Whether a range is confirmed at once or held for the host is
 * `instant-book.server.ts`; a confirmed range raises its `stay_total` charge. `dryRun: true` runs every check and
 * writes nothing, which is how the sheet learns what its button should say.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { propertyStayClockFromRecord } from "@/lib/bookings/property-stay-times.server";
import { normalizeStayTime, type PropertyStayTimes } from "@/lib/bookings/stay-times";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { bestEffortFailed } from "@/lib/observability/best-effort";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import {
  CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
  ROOM_DATE_BLOCK_RECORD_TYPE,
} from "@/lib/portal-schedule-record-scope";
import { normalizeE164 } from "@/lib/phone-e164";
import { isPlaceholderImportEmail } from "@/lib/portfolio-import/placeholder-email";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { pacificTodayKey, rangeDaysBetween } from "@/lib/room-availability-range";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import {
  GUEST_PORTAL_SHORT_STAY_SOURCE,
  SMS_SHORT_STAY_SOURCE,
  SHORT_STAY_HOLD_HOURS,
  SHORT_STAY_MAX_RANGES,
  guestBookAction,
  guestBookSummaryLine,
  guestStayConfirmedText,
  guestStayRequestedText,
  shortStayRangesOverlap,
  type GuestBookAction,
  type GuestRangeResult,
  type GuestStay,
  type GuestStayPayment,
} from "@/lib/short-stay/guest-stays";
import { deliverGuestPortalNotice } from "@/lib/short-stay/guest-notice.server";
import { emitShortStayTeamNotice, loadOwnerIdentity, loadStayLabels } from "@/lib/short-stay/hold-decisions.server";
import { guestStayPortalNotice, noticeChannelFor } from "@/lib/short-stay/notice-channel";
import type { StayApplicationAnswers } from "@/lib/short-stay/stay-application";
import { guestIsReturning, instantBookStatus, listingBooksReturningGuestsInstantly } from "@/lib/short-stay/instant-book.server";
import { ensureGuestStayCharge, guestStayChargeId } from "@/lib/short-stay/stay-charge.server";
import { mintStayPayLink } from "@/lib/short-stay/stay-pay-link.server";
import { readStayAddOns } from "@/lib/short-stay/stay-add-ons";
import { raiseRequestedStayAddOnCharges, storedStayTimes } from "@/lib/short-stay/stay-add-ons.server";
import {
  createShortStayRows,
  emitShortStayRequestedEvent,
  loadShortStayListing,
  requestedAddOnKinds,
  type ShortStayRowRange,
} from "@/lib/short-stay-request.server";
import {
  SHORT_STAY_MAX_GUESTS,
  listingOffersShortStay,
  shortStayRoomNightly,
  validateShortStayDates,
} from "@/lib/short-stay-request";
import { resolveProfileFullName } from "@/lib/auth/profile-name.server";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** Open (pending) requests one guest may have at a time. */
export const GUEST_OPEN_REQUEST_CAP = 6;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

type PropertyRow = { id: string; status: string | null; property_data: unknown };

type BookableRoom = { id: string; label: string; nightly: number; sleeps: number };

function bookableRooms(submission: ManagerListingSubmissionV1): BookableRoom[] {
  if (!listingOffersShortStay(submission)) return [];
  return (submission.rooms ?? []).flatMap((room, index) => {
    const nightly = shortStayRoomNightly(room, submission.shortTermDailyCost);
    return room.id && nightly > 0
      ? [{ id: room.id, label: room.name?.trim() || `Room ${index + 1}`, nightly, sleeps: normalizeRoomOccupancyCapacity(room.occupancyCapacity) }]
      : [];
  });
}

function propertyLabelOf(data: Record<string, unknown>): string {
  return String(data.buildingName || data.title || data.address || "the house").trim();
}

/* ─────────────────────────────── list ─────────────────────────────── */

type StayRecord = { id: string; property_id: string | null; record_type: string; row_data: unknown };

/** Pure: one stored block as the guest's list row. */
export function guestStayFromRecord(
  record: StayRecord,
  property: { propertyLabel: string; roomLabel: string; canBookAgain: boolean; stayTimes?: PropertyStayTimes; payment?: GuestStayPayment },
): GuestStay | null {
  const row = asRecord(record.row_data);
  const checkIn = String(row.checkIn ?? "");
  const checkOut = String(row.checkOut ?? "");
  if (!checkIn || !checkOut) return null;
  const details = asRecord(row.stayDetails);
  const cancelled = record.record_type === CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE;
  const status: GuestStay["status"] = cancelled
    ? details.decision === "declined"
      ? "declined"
      : details.decision === "expired" || details.decision === "unpaid_expired"
        ? "expired"
        : "cancelled"
    : row.bookingStatus === "confirmed"
      ? "confirmed"
      : "pending";
  const nightly = Number(row.rate);
  const nights = Number(row.quotedNights) || Math.max(1, rangeDaysBetween(checkIn, checkOut));
  const quoted = Number(row.quotedTotal);
  const guests = Number(details.guests ?? row.guests);
  const times = property.stayTimes ? storedStayTimes(row, property.stayTimes) : null;
  const addOns = readStayAddOns(details);
  return {
    id: record.id,
    propertyId: String(record.property_id ?? row.propertyId ?? ""),
    roomId: String(row.roomId ?? ""),
    propertyLabel: property.propertyLabel,
    roomLabel: property.roomLabel,
    checkIn,
    checkOut,
    nights,
    guests: Number.isInteger(guests) && guests > 0 ? guests : 1,
    status,
    holdExpiresAt: status === "pending" && typeof details.holdExpiresAt === "string" ? details.holdExpiresAt : null,
    total: Number.isFinite(quoted) && quoted > 0 ? quoted : Number.isFinite(nightly) && nightly > 0 ? Math.round(nightly * nights * 100) / 100 : null,
    nightly: Number.isFinite(nightly) && nightly > 0 ? nightly : null,
    canBookAgain: property.canBookAgain,
    ...(status === "confirmed" ? { payment: property.payment ?? "none" } : {}),
    ...(times ?? {}),
    estimatedArrival: normalizeStayTime(details.estimatedArrival),
    ...(Object.keys(addOns).length ? { addOns } : {}),
  };
}

/** Pure: the guest-facing standing of a stay_total charge row's status. */
export function guestStayPaymentFromChargeStatus(status: string | null | undefined): GuestStayPayment {
  switch (String(status ?? "").toLowerCase()) {
    case "paid":
    case "refunded":
      return "paid";
    case "processing":
      return "processing";
    case "pending":
    case "failed":
    case "partially_paid":
      return "due";
    default:
      return "none";
  }
}

async function readStayPayments(db: SupabaseClient, blockIds: readonly string[]): Promise<Map<string, GuestStayPayment>> {
  const out = new Map<string, GuestStayPayment>();
  if (blockIds.length === 0) return out;
  const idFor = new Map(blockIds.map((id) => [guestStayChargeId(id), id]));
  const { data, error } = await db.from("portal_household_charge_records").select("id, status").in("id", [...idFor.keys()]);
  // An unreadable charge table is "no charge": the row still draws, only without Pay.
  if (error) return out;
  for (const row of (data ?? []) as Array<{ id: string; status: string | null }>) {
    const blockId = idFor.get(row.id);
    if (blockId) out.set(blockId, guestStayPaymentFromChargeStatus(row.status));
  }
  return out;
}

export async function listGuestStays(db: SupabaseClient, input: { userId: string }): Promise<GuestStay[]> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, property_id, record_type, row_data")
    .in("record_type", [ROOM_DATE_BLOCK_RECORD_TYPE, CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE])
    .filter("row_data->>residentUserId", "eq", input.userId)
    .order("starts_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("Could not load your stays.");
  const records = (data ?? []) as StayRecord[];
  const propertyIds = [...new Set(records.map((r) => String(r.property_id ?? "")).filter(Boolean))];
  const properties = new Map<string, PropertyRow>();
  if (propertyIds.length) {
    const { data: rows } = await db
      .from("manager_property_records")
      .select("id, status, property_data")
      .in("id", propertyIds);
    for (const row of (rows ?? []) as PropertyRow[]) properties.set(row.id, row);
  }
  // Where each confirmed stay's stay_total stands (read by the charge id the block id derives).
  const payments = await readStayPayments(db, records.filter((record) => asRecord(record.row_data).bookingStatus === "confirmed" && record.record_type === ROOM_DATE_BLOCK_RECORD_TYPE).map((record) => record.id));
  const stays: GuestStay[] = [];
  for (const record of records) {
    const property = properties.get(String(record.property_id ?? ""));
    const data = asRecord(property?.property_data);
    const submission = asRecord(data.listingSubmission) as ManagerListingSubmissionV1;
    const rooms = submission.rooms ?? [];
    const roomId = String(asRecord(record.row_data).roomId ?? "");
    const roomIndex = rooms.findIndex((room) => room.id === roomId);
    const bookable = bookableRooms(submission).some((room) => room.id === roomId);
    const stay = guestStayFromRecord(record, {
      propertyLabel: property ? propertyLabelOf(data) : "A PropLane home",
      roomLabel: roomIndex >= 0 ? rooms[roomIndex]!.name?.trim() || `Room ${roomIndex + 1}` : "Room",
      canBookAgain: Boolean(property && property.status === "live" && bookable),
      stayTimes: propertyStayClockFromRecord(property ? { property_data: property.property_data } : null).times,
      payment: payments.get(record.id),
    });
    if (stay) stays.push(stay);
  }
  return stays;
}

/* ───────────────────────── the sheet's listing read ───────────────────────── */

export type GuestBookableListing = {
  propertyId: string;
  propertyLabel: string;
  rooms: BookableRoom[];
  /** True when the guest would be confirmed at once for free nights (the host ticked instant book AND a completed stay here). Off by default: a web request is an application. */
  confirmsInstantly: boolean;
  /** The listing's house rules and short-stay requirements, shown on the request page next to the agreement. */
  houseRules: string;
  shortStayRequirements: string;
  /** The standard times and add-on prices the sheet shows. The cleaning buffer is the host's and is not sent. */
  stayTimes: Omit<PropertyStayTimes, "cleaningBufferMinutes">;
};

function publicStayTimes(times: PropertyStayTimes): GuestBookableListing["stayTimes"] {
  const { cleaningBufferMinutes: _buffer, ...shown } = times;
  void _buffer;
  return shown;
}

export async function loadGuestBookableListing(
  db: SupabaseClient,
  input: { propertyId: string; userId: string; email: string; phone: string; phoneVerified?: boolean; today?: string },
): Promise<GuestBookableListing | null> {
  const { data } = await db
    .from("manager_property_records")
    .select("id, status, property_data")
    .eq("id", input.propertyId)
    .is("test_workspace_id", null)
    .maybeSingle();
  if (!data || data.status !== "live") return null;
  const property = asRecord(data.property_data);
  const submission = asRecord(property.listingSubmission) as ManagerListingSubmissionV1;
  const rooms = bookableRooms(submission);
  if (!rooms.length) return null;
  const returning = await guestIsReturning(db, {
    propertyId: input.propertyId,
    who: { userId: input.userId, email: input.email, phone: input.phone, phoneVerified: input.phoneVerified === true },
    today: input.today ?? pacificTodayKey(),
  });
  return {
    propertyId: input.propertyId,
    propertyLabel: propertyLabelOf(property),
    rooms,
    confirmsInstantly: instantBookStatus({ flagOn: listingBooksReturningGuestsInstantly(submission), returning }) === "confirmed",
    houseRules: typeof submission.houseRulesText === "string" ? submission.houseRulesText.trim() : "",
    shortStayRequirements: typeof submission.shortTermRequirements === "string" ? submission.shortTermRequirements.trim() : "",
    stayTimes: publicStayTimes(propertyStayClockFromRecord({ property_data: data.property_data }).times),
  };
}

/* ─────────────────────────────── book ─────────────────────────────── */

export type GuestBookBody = {
  propertyId?: unknown;
  roomId?: unknown;
  ranges?: unknown;
  guests?: unknown;
  dryRun?: unknown;
  /** "HH:MM" the guest expects to arrive (stored on every stay of the request). */
  estimatedArrival?: unknown;
  /** Paid add-ons ticked in the sheet (`early_check_in` / `late_check_out`), kept on each stay only where available. */
  addOns?: unknown;
};

export type GuestBookResult =
  | { ok: true; dryRun: boolean; results: GuestRangeResult[]; action: GuestBookAction; summary: string }
  | { ok: false; status: 400 | 404 | 409 | 429 | 503; error: string };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function bookGuestStays(
  db: SupabaseClient,
  input: {
    userId: string;
    body: GuestBookBody;
    today?: string;
    now?: Date;
    /**
     * "sms": the stay was booked by text (`request_short_stay`). Same core, same rules; the row says so
     * (`stayDetails.source`), the host's notice says so, and the reply to the texter IS the confirmation, so
     * no second text goes out from here.
     */
    via?: "sms";
    /** The booking application's answers (`checkStayApplication`): saved on every stay of the request. */
    application?: StayApplicationAnswers | null;
  },
): Promise<GuestBookResult> {
  const today = input.today ?? pacificTodayKey(input.now);
  const body = input.body;
  const propertyId = str(body.propertyId, 200);
  const roomId = str(body.roomId, 200);
  const guests = Number(body.guests);
  const dryRun = body.dryRun === true;
  if (!propertyId || !roomId) return { ok: false, status: 400, error: "Choose a room." };
  if (!Number.isInteger(guests) || guests < 1 || guests > SHORT_STAY_MAX_GUESTS) {
    return { ok: false, status: 400, error: "Choose how many guests." };
  }
  const rawRanges = Array.isArray(body.ranges) ? (body.ranges as unknown[]) : [];
  if (rawRanges.length < 1) return { ok: false, status: 400, error: "Choose the dates." };
  if (rawRanges.length > SHORT_STAY_MAX_RANGES) {
    return { ok: false, status: 400, error: `Book up to ${SHORT_STAY_MAX_RANGES} stays at a time.` };
  }

  // The guest is who the session says: name, mobile and login address come from the profile.
  const { data: profile } = await db.from("profiles").select("full_name, email, phone, phone_verified_at").eq("id", input.userId).maybeSingle();
  const name = (await resolveProfileFullName(db, input.userId, profile?.full_name)) || "Guest";
  const email = String(profile?.email ?? "").trim().toLowerCase();
  const phone = normalizeE164(String(profile?.phone ?? "")) ?? "";
  // Settings lets a resident retype this number (and clears the verification with it), so it stands
  // in for identity only once it is verified - see `rowMatchesGuest` in instant-book.server.ts.
  const phoneVerified = Boolean(profile?.phone_verified_at);
  if (!phone) return { ok: false, status: 400, error: "Add a mobile number in Settings so we can text you." };

  const loaded = await loadShortStayListing(db, { propertyId, roomId, guests });
  if (!loaded.ok) return { ok: false, status: loaded.status, error: loaded.error };
  const { listing } = loaded;

  // Validate every range on its own; one bad or overlapping range does not stop the others.
  const results: GuestRangeResult[] = [];
  const valid: ShortStayRowRange[] = [];
  const validIndex: number[] = [];
  rawRanges.forEach((raw, index) => {
    const range = asRecord(raw);
    const checked = validateShortStayDates(range.checkIn, range.checkOut, today);
    if (!checked.ok) {
      results[index] = { checkIn: str(range.checkIn, 10), checkOut: str(range.checkOut, 10), nights: 0, total: null, outcome: "invalid", error: checked.error };
      return;
    }
    if (valid.some((other) => shortStayRangesOverlap(other, checked))) {
      results[index] = { checkIn: checked.checkIn, checkOut: checked.checkOut, nights: checked.nights, total: null, outcome: "invalid", error: "These dates overlap another stay in this request." };
      return;
    }
    valid.push({ checkIn: checked.checkIn, checkOut: checked.checkOut, nights: checked.nights });
    validIndex.push(index);
  });

  if (valid.length) {
    const returning = await guestIsReturning(db, { propertyId, who: { userId: input.userId, email, phone, phoneVerified }, today });
    const status = instantBookStatus({ flagOn: listingBooksReturningGuestsInstantly(listing.submission), returning });

    if (status === "hold" && !dryRun) {
      const open = (await listGuestStays(db, { userId: input.userId })).filter((stay) => stay.status === "pending").length;
      if (open + valid.length > GUEST_OPEN_REQUEST_CAP) {
        return { ok: false, status: 429, error: "You have too many open requests. Wait for the host to answer one." };
      }
    }

    const created = await createShortStayRows(db, {
      actor: { source: input.via === "sms" ? SMS_SHORT_STAY_SOURCE : GUEST_PORTAL_SHORT_STAY_SOURCE, name, phone, email, residentUserId: input.userId },
      listing,
      guests,
      ranges: valid,
      status,
      dryRun,
      now: input.now,
      estimatedArrival: normalizeStayTime(body.estimatedArrival),
      addOns: requestedAddOnKinds(body.addOns),
      application: input.application ?? null,
    });
    created.forEach((row, i) => {
      const target = validIndex[i]!;
      results[target] = row.ok
        ? {
            checkIn: row.range.checkIn,
            checkOut: row.range.checkOut,
            nights: row.range.nights,
            total: row.total,
            outcome: row.status === "confirmed" ? "confirmed" : "pending",
            ...(row.blockId ? { stayId: row.blockId } : {}),
            addOns: row.addOnOffers,
            ...(row.addOnsSkipped.length ? { addOnsSkipped: row.addOnsSkipped } : {}),
          }
        : { checkIn: row.range.checkIn, checkOut: row.range.checkOut, nights: row.range.nights, total: null, outcome: "unavailable", error: row.error };
    });

    if (!dryRun) {
      const written = created.flatMap((row) => (row.ok && row.blockId && row.rowData ? [{ ...row, blockId: row.blockId, rowData: row.rowData }] : []));
      const labels = await loadStayLabels(db, propertyId, roomId);
      // Read once for every range: both notice emitters need the owner's address, and a five-range
      // request was issuing up to ten identical `profiles` selects.
      const owner = written.length ? await loadOwnerIdentity(db, listing.ownerId) : { email: "", name: "" };
      for (const row of written) {
        if (row.status === "confirmed") {
          // An instant confirm never passes through the host's Approve, so this is the ONLY call to the
          // idempotent charge writer for this stay: a failure that is not written down is lost revenue
          // nobody can find. `ensureGuestStayCharge` logs its own `{ ok: false }`; this catches a throw.
          await ensureGuestStayCharge(db, { blockId: row.blockId, ownerId: listing.ownerId, propertyId, propertyLabel: listing.propertyLabel, row: row.rowData })
            .catch(bestEffortFailed("guest stay charge", { blockId: row.blockId, propertyId }));
          // Add-ons asked for at booking were stored `requested`; the stay is confirmed, so their charges go up now.
          await raiseRequestedStayAddOnCharges(db, { blockId: row.blockId, now: input.now });
          await emitShortStayTeamNotice(db, { event: "short_stay_confirmed", headline: "Short stay confirmed", blockId: row.blockId, ownerId: listing.ownerId, propertyId, row: row.rowData, labels, owner }).catch(() => undefined);
        } else {
          await emitShortStayRequestedEvent(db, {
            ownerId: listing.ownerId,
            ownerEmail: owner.email,
            ownerName: owner.name,
            propertyId,
            roomId,
            blockId: row.blockId,
            propertyLabel: listing.propertyLabel,
            roomLabel: listing.roomLabel,
            guestName: name,
            guests,
            checkIn: row.range.checkIn,
            checkOut: row.range.checkOut,
            nights: row.range.nights,
            total: row.total,
            headline: input.via === "sms" ? "Short-stay request by text" : "Short-stay request from a returning guest",
          }).catch(() => undefined);
        }
      }
      if (written.length && input.via !== "sms") {
        // Channel-aware (notice-channel.ts): a stay made in the portal is answered by email + the portal
        // inbox, never a text and never a /l/ pay link; the text path below is for a row made by text.
        const portalRows = written.filter((row) => noticeChannelFor(row.rowData) === "portal");
        const smsRows = written.filter((row) => noticeChannelFor(row.rowData) !== "portal");
        for (const row of portalRows) {
          await deliverGuestPortalNotice(db, {
            ownerId: listing.ownerId,
            propertyId,
            blockId: row.blockId,
            event: row.status === "confirmed" ? "short_stay_confirmed" : "short_stay_requested",
            row: row.rowData,
            notice: guestStayPortalNotice(row.status === "confirmed" ? "confirmed" : "requested", {
              roomLabel: listing.roomLabel,
              propertyLabel: listing.propertyLabel,
              checkIn: row.range.checkIn,
              checkOut: row.range.checkOut,
              nights: row.range.nights,
              total: row.total,
            }),
          }).catch(bestEffortFailed("guest portal notice", { blockId: row.blockId, propertyId }));
        }
        if (smsRows.length) {
          await textGuest(db, {
            ownerId: listing.ownerId,
            propertyId,
            phone,
            email,
            roomLabel: listing.roomLabel,
            propertyLabel: listing.propertyLabel,
            written: smsRows.map((row) => ({ blockId: row.blockId, status: row.status, checkIn: row.range.checkIn, checkOut: row.range.checkOut, nights: row.range.nights, total: row.total })),
          }).catch(() => undefined);
        }
      }
    }
  }

  const summary = guestBookSummaryLine(results);
  return { ok: true, dryRun, results, action: guestBookAction(results), summary };
}

async function textGuest(
  db: SupabaseClient,
  input: {
    ownerId: string;
    propertyId: string;
    phone: string;
    email: string;
    roomLabel: string;
    propertyLabel: string;
    written: Array<{ blockId: string; status: "hold" | "confirmed"; checkIn: string; checkOut: string; nights: number; total: number }>;
  },
): Promise<void> {
  const portalUrl = residentPortalUrl("stays");
  const base = { roomLabel: input.roomLabel, propertyLabel: input.propertyLabel };
  const one = input.written.length === 1 ? input.written[0]! : null;
  // A stay confirmed at once is paid from a phone-bound link in the same text.
  const payUrl =
    one && one.status === "confirmed"
      ? await mintStayPayLink(db, { blockId: one.blockId, ownerId: input.ownerId, propertyId: input.propertyId, phone: input.phone }).catch(() => null)
      : null;
  const text = one
    ? one.status === "confirmed"
      ? guestStayConfirmedText({ ...base, checkIn: one.checkIn, checkOut: one.checkOut, nights: one.nights, total: one.total }, portalUrl, payUrl)
      : guestStayRequestedText({ ...base, checkIn: one.checkIn, checkOut: one.checkOut, nights: one.nights, total: one.total })
    : `PropLane: ${guestBookSummaryLine(input.written.map((row) => ({ outcome: row.status === "confirmed" ? "confirmed" : "pending" })))} at ${input.propertyLabel}.${
        input.written.some((row) => row.status === "hold") ? ` The host has ${SHORT_STAY_HOLD_HOURS} hours to confirm.` : ""
      } See them in your portal: ${portalUrl}`;
  await enqueueOwnerSms(
    {
      managerUserId: input.ownerId,
      actorUserId: input.ownerId,
      recipientPhone: input.phone,
      recipientEmail: input.email || undefined,
      body: text,
      sendClass: "transactional",
      purpose: "short_stay_guest_booking",
      counterpartyRole: "prospect",
      propertyId: input.propertyId,
      dedupeKey: `short-stay-guest:${input.written.map((row) => row.blockId).join(",")}`.slice(0, 250),
    },
    db,
  ).catch(() => undefined);
  if (input.email && !isPlaceholderImportEmail(input.email) && !shouldSkipOutboundEmail(input.email) && process.env.RESEND_API_KEY?.trim()) {
    await postResendEmail({
      apiKey: process.env.RESEND_API_KEY.trim(),
      actorUserId: input.ownerId,
      payload: {
        from: await managerOutboundFromHeader(db, input.ownerId),
        to: [input.email],
        subject: `Your stay: ${input.roomLabel} at ${input.propertyLabel}`,
        // The pay link is texted to the phone it is bound to, never emailed.
        text: payUrl ? text.replace(payUrl, residentPortalUrl("stays")) : text,
      },
      effectSummary: "Short-stay booking email was captured for SMS test mode.",
      metadata: { recipients: 1 },
    }).catch(() => undefined);
  }
}
