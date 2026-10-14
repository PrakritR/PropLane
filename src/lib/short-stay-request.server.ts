import "server-only";

/**
 * A guest's "Request to book" on a public listing (`POST /api/public/short-stay-request`).
 *
 * It creates exactly what the manager's "Add booking" sheet saves: a `room_date_block` hold in
 * `portal_schedule_records` with the guest on it (name, phone, email), the nightly rate stored on the
 * stay. Nothing is charged and no resident account is made - the manager confirms in Bookings. The
 * guest is texted from the workspace work number (email too when given) and the owner and every
 * teammate with the house hear about it through the notice spine.
 *
 * Availability is re-checked here against the same occupancy the listing reads; the capacity trigger
 * on `portal_schedule_records` is the last word, and a refusal there is a 409 too. Nothing this
 * returns names another guest.
 *
 * ONE core writes every short-stay row: `createShortStayRows`. The public route (this file's
 * `submitShortStayRequest`, which keeps its own rate limits) and the signed-in guest's
 * `POST /api/resident/stays` (`short-stay/guest-stays.server.ts`) both call it, so a stay row has
 * one shape: `stayDetails.guests` (the capacity trigger weighs a stay by it), a 24-hour
 * `holdExpiresAt` on a hold, the guest's `residentUserId` and a `source`.
 */
import { randomUUID } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import { normalizeE164 } from "@/lib/phone-e164";
import { ROOM_DATE_BLOCK_RECORD_TYPE, roomDateBlockRecordId } from "@/lib/portal-schedule-record-scope";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { roomAvailabilityForRange } from "@/lib/room-availability-range.server";
import { pacificTodayKey } from "@/lib/room-availability-range";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { ensureGuestLogin } from "@/lib/short-stay/guest-login.server";
import {
  GUEST_PORTAL_SHORT_STAY_SOURCE,
  PUBLIC_SHORT_STAY_SOURCE,
  shortStayHoldExpiresAt,
  withGuestSignInLink,
} from "@/lib/short-stay/guest-stays";
import {
  SHORT_STAY_MAX_GUESTS,
  formatShortStayMoney,
  listingOffersShortStay,
  shortStayRangeLabel,
  shortStayRequestAckText,
  shortStayRoomNightly,
  shortStayTotal,
  validateShortStayDates,
} from "@/lib/short-stay-request";

export type ShortStayRequestBody = {
  propertyId?: unknown;
  roomId?: unknown;
  checkIn?: unknown;
  checkOut?: unknown;
  guests?: unknown;
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  /** A field real people never see; any value means a bot. */
  honeypot?: unknown;
};

export type ShortStayRequestResult = { ok: true } | { ok: false; status: 400 | 404 | 409 | 429 | 503; error: string };

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function submitShortStayRequest(
  db: SupabaseClient,
  body: ShortStayRequestBody,
  options: { today?: string } = {},
): Promise<ShortStayRequestResult> {
  // A bot filled the hidden field: answer as if it worked, create nothing.
  if (str(body.honeypot, 200)) return { ok: true };

  const propertyId = str(body.propertyId, 200);
  const roomId = str(body.roomId, 200);
  const name = str(body.name, 120);
  const phone = normalizeE164(str(body.phone, 40));
  const email = str(body.email, 320).toLowerCase();
  const guests = Number(body.guests);
  if (!propertyId || !roomId) return { ok: false, status: 400, error: "Choose a room." };
  if (!name) return { ok: false, status: 400, error: "Enter your name." };
  if (!phone) return { ok: false, status: 400, error: "Enter a mobile number so we can text you." };
  if (email && !EMAIL_RE.test(email)) return { ok: false, status: 400, error: "That email doesn't look right." };
  if (!Number.isInteger(guests) || guests < 1 || guests > SHORT_STAY_MAX_GUESTS) {
    return { ok: false, status: 400, error: "Choose how many guests." };
  }
  const dates = validateShortStayDates(body.checkIn, body.checkOut, options.today ?? pacificTodayKey());
  if (!dates.ok) return { ok: false, status: 400, error: dates.error };

  // Abuse caps beyond the route's per-IP limit: one phone and one listing can each be flooded from many IPs.
  if (!(await rateLimit(`short-stay-phone:${phone}`, 3, 86_400_000)).ok) {
    return { ok: false, status: 429, error: "Too many requests from this number today. Please try again tomorrow." };
  }
  if (!(await rateLimit(`short-stay-property:${propertyId}`, 30, 3_600_000)).ok) {
    return { ok: false, status: 429, error: "Too many requests for this listing right now. Please try again later." };
  }
  const todayKey = options.today ?? pacificTodayKey();

  const loaded = await loadShortStayListing(db, { propertyId, roomId, guests });
  if (!loaded.ok) return { ok: false, status: loaded.status, error: loaded.error };
  const { listing } = loaded;
  const { ownerId, roomLabel, propertyLabel } = listing;

  // Open (not yet checked-out) holds on this listing: one per phone per room, and a ceiling per property.
  const { data: openRows } = await db
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("property_id", propertyId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
    .gte("ends_at", `${todayKey}T00:00:00`)
    .limit(500);
  const openHolds = ((openRows ?? []) as Array<{ row_data?: Record<string, unknown> | null }>)
    .map((r) => r.row_data ?? {})
    .filter((d) => d.bookingStatus === "hold" && String(d.checkOut ?? "") > todayKey);
  if (openHolds.some((d) => d.roomId === roomId && normalizeE164(String(d.residentPhone ?? "")) === phone)) {
    return { ok: false, status: 409, error: "You already have a request for this room." };
  }
  const openShortStay = openHolds.filter((d) => (d.stayDetails as { source?: string } | undefined)?.source === PUBLIC_SHORT_STAY_SOURCE);
  if (openShortStay.length >= 20) {
    return { ok: false, status: 429, error: "Too many open requests for this listing right now." };
  }

  const [created] = await createShortStayRows(db, {
    actor: { source: PUBLIC_SHORT_STAY_SOURCE, name, phone, email, residentUserId: null },
    listing,
    guests,
    ranges: [{ checkIn: dates.checkIn, checkOut: dates.checkOut, nights: dates.nights }],
    status: "hold",
  });
  if (!created || !created.ok || !created.blockId) {
    const failed = created && !created.ok ? created : { status: 503 as const, error: "We couldn't save your request. Try again in a minute." };
    return { ok: false, status: failed.status, error: failed.error };
  }
  const blockId = created.blockId;
  const total = created.total;

  // The hold exists; everything below is notification and must never undo it.
  // A guest without a login gets one, and the confirmation text carries the one-time sign-in link
  // (`token_hash`, never a PKCE code) so the Stays page becomes theirs.
  const login = await ensureGuestLogin(db, { name, phone, email }).catch(() => null);
  if (login?.userId && created.rowData) {
    await linkRowToGuest(db, blockId, created.rowData, login.userId).catch(() => undefined);
  }
  const { data: owner } = await db.from("profiles").select("email, full_name").eq("id", ownerId).maybeSingle();
  const ownerName = String(owner?.full_name ?? "").trim();
  const ack = withGuestSignInLink(
    shortStayRequestAckText({
      guestName: name,
      roomLabel,
      propertyLabel,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
      total,
      ownerFirstName: ownerName.split(/\s+/)[0] ?? "",
    }),
    login?.signInUrl,
  );
  await enqueueOwnerSms(
    {
      managerUserId: ownerId,
      actorUserId: ownerId,
      recipientPhone: phone,
      recipientEmail: email || undefined,
      body: ack,
      sendClass: "transactional",
      purpose: "short_stay_request_ack",
      counterpartyRole: "prospect",
      propertyId,
      dedupeKey: `short-stay:${phone}:${todayKey}`,
    },
    db,
  ).catch(() => undefined);

  if (email && !shouldSkipOutboundEmail(email) && process.env.RESEND_API_KEY?.trim()) {
    try {
      await postResendEmail({
        apiKey: process.env.RESEND_API_KEY.trim(),
        actorUserId: ownerId,
        payload: {
          from: await managerOutboundFromHeader(db, ownerId),
          to: [email],
          subject: `Your request: ${roomLabel} at ${propertyLabel}`,
          text: ack,
        },
        effectSummary: "Short-stay request confirmation email was captured for SMS test mode.",
        metadata: { recipients: 1 },
      });
    } catch {
      // The text already went; a failed email changes nothing about the hold.
    }
  }

  await emitShortStayRequestedEvent(db, {
    ownerId,
    ownerEmail: String(owner?.email ?? "").trim().toLowerCase(),
    ownerName,
    propertyId,
    roomId,
    blockId,
    propertyLabel,
    roomLabel,
    guestName: name,
    guests,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    nights: dates.nights,
    total,
  });
  return { ok: true };
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
  source: typeof PUBLIC_SHORT_STAY_SOURCE | typeof GUEST_PORTAL_SHORT_STAY_SOURCE;
  name: string;
  phone: string;
  email: string;
  /** The guest's login when there is one (always for the portal route, after the fact for the public card). */
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
  },
): Promise<ShortStayRowResult[]> {
  const { actor, listing, guests, status } = input;
  const nowDate = input.now ?? new Date();
  const results: ShortStayRowResult[] = [];
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
    if (input.dryRun) {
      results.push({ ok: true, range, status, total, blockId: null, holdExpiresAt: null, rowData: null });
      continue;
    }

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
      },
      createdAt: now,
      startsAt: `${range.checkIn}T00:00:00`,
      endsAt: `${range.checkOut}T00:00:00`,
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
    results.push({ ok: true, range, status, total, blockId, holdExpiresAt, rowData });
  }
  return results;
}

/** Stamps the guest's login onto a row that was written before the login existed (the public card). */
async function linkRowToGuest(db: SupabaseClient, blockId: string, rowData: Record<string, unknown>, userId: string): Promise<void> {
  await db
    .from("portal_schedule_records")
    .update({ row_data: { ...rowData, residentUserId: userId }, updated_at: new Date().toISOString() })
    .eq("id", blockId);
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
    /** Said in the notice when the guest booked from their portal rather than the public card. */
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
