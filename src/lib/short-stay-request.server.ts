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

  const { data: record } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, status, property_data")
    .eq("id", propertyId)
    .is("test_workspace_id", null)
    .maybeSingle();
  const ownerId = String(record?.manager_user_id ?? "").trim();
  if (!record || record.status !== "live" || !ownerId) return { ok: false, status: 404, error: "Listing not found." };
  const property = (record.property_data ?? {}) as { title?: string; buildingName?: string; address?: string; listingSubmission?: unknown };
  // The stored submission as-is: `roomAvailabilityForRange` normalizes it itself and refuses an unreadable one.
  const submission = (property.listingSubmission ?? {}) as ManagerListingSubmissionV1;
  if (!listingOffersShortStay(submission)) return { ok: false, status: 400, error: "This listing doesn't take short stays." };
  const rooms = submission.rooms ?? [];
  const roomIndex = rooms.findIndex((room) => room.id === roomId);
  const room = rooms[roomIndex];
  if (!room) return { ok: false, status: 404, error: "Room not found." };
  if (guests > normalizeRoomOccupancyCapacity(room.occupancyCapacity)) {
    return { ok: false, status: 400, error: "That's more guests than the room sleeps." };
  }
  const nightly = shortStayRoomNightly(room, submission.shortTermDailyCost);
  if (nightly <= 0) return { ok: false, status: 400, error: "This room has no nightly rate." };

  const availability = await roomAvailabilityForRange(
    { propertyId, roomId, moveIn: dates.checkIn, moveOut: dates.checkOut },
    { submission, expectedOwnerId: ownerId },
  );
  if (!availability.ok) return { ok: false, status: 400, error: "Those dates aren't valid." };
  const verdict = availability.rooms[0];
  if (!verdict || verdict.available === null) {
    return { ok: false, status: 503, error: "We couldn't check the calendar right now. Try again in a minute." };
  }
  if (!verdict.available) return { ok: false, status: 409, error: "That room was just booked for those dates." };

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
  const openShortStay = openHolds.filter((d) => (d.stayDetails as { source?: string } | undefined)?.source === "public_short_stay_request");
  if (openShortStay.length >= 20) {
    return { ok: false, status: 429, error: "Too many open requests for this listing right now." };
  }

  const total = shortStayTotal(nightly, dates.nights);
  const now = new Date().toISOString();
  const blockId = roomDateBlockRecordId(ownerId, randomUUID());
  const rowData = {
    id: blockId,
    recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
    propertyId,
    roomId,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    reason: "Short-stay request",
    bookingStatus: "hold",
    rate: nightly,
    rateBasis: "daily",
    quotedNights: dates.nights,
    quotedTotal: total,
    guests,
    residentName: name,
    residentPhone: phone,
    ...(email ? { residentEmail: email } : {}),
    stayDetails: { source: "public_short_stay_request" },
    createdAt: now,
    startsAt: `${dates.checkIn}T00:00:00`,
    endsAt: `${dates.checkOut}T00:00:00`,
  };
  const { error: insertError } = await db.from("portal_schedule_records").upsert(
    {
      id: blockId,
      manager_user_id: ownerId,
      property_id: propertyId,
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
      return { ok: false, status: 409, error: "That room was just booked for those dates." };
    }
    return { ok: false, status: 503, error: "We couldn't save your request. Try again in a minute." };
  }

  // The hold exists; everything below is notification and must never undo it.
  const propertyLabel = (property.buildingName || property.title || property.address || "the house").trim();
  const roomLabel = room.name?.trim() || `Room ${roomIndex + 1}`;
  const { data: owner } = await db.from("profiles").select("email, full_name").eq("id", ownerId).maybeSingle();
  const ownerName = String(owner?.full_name ?? "").trim();
  const ack = shortStayRequestAckText({
    guestName: name,
    roomLabel,
    propertyLabel,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    total,
    ownerFirstName: ownerName.split(/\s+/)[0] ?? "",
  });
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

  const ownerEmail = String(owner?.email ?? "").trim().toLowerCase();
  if (ownerEmail) {
    const stayLabel = `${shortStayRangeLabel(dates.checkIn, dates.checkOut)} (${dates.nights} ${dates.nights === 1 ? "night" : "nights"})`;
    const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/bookings/${encodeURIComponent(`block:${blockId}`)}`;
    const text = ["Short-stay request", propertyLabel, roomLabel, stayLabel, `${name} · ${guests} ${guests === 1 ? "guest" : "guests"}`, formatShortStayMoney(total)].join(" · ");
    await emitActionEvent(db, {
      eventId: `short_stay_requested:${blockId}`,
      domain: "channel_booking",
      event: "short_stay_requested",
      managerUserId: ownerId,
      entityId: blockId,
      category: "tours",
      senderUserId: ownerId,
      senderEmail: ownerEmail,
      senderName: ownerName || undefined,
      payload: { propertyId, roomId, blockId, start: dates.checkIn, end: dates.checkOut, nights: dates.nights, guests },
      templateContext: { propertyTitle: propertyLabel, roomLabel, stayLabel, url },
      recipients: [{ audience: "manager", userId: ownerId, rendered: { subject: "Short-stay request", text: `${text}\n\n${url}`, smsText: `${text}\n${url}` } }],
    }).catch(() => undefined);
  }
  return { ok: true };
}
