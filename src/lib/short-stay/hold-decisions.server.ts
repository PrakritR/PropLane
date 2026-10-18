import "server-only";

/**
 * The three ways a guest's short-stay request (a 24-hour `hold`) ends: the host approves it, declines
 * it, or the 24 hours run out (the `short-stay-hold-expiry` cron). One module, one compare-and-swap,
 * so a double-clicked Approve, an Approve racing the cron and a Decline of an answered request all
 * resolve to exactly one outcome:
 *
 * - approve -> the row becomes `confirmed` and raises its `stay_total` charge (idempotent on the block id);
 * - decline / expire -> the row moves to `cancelled_room_date_block`, which frees the nights (the capacity
 *   trigger and the export feed both ignore a cancelled block) and records WHY in `stayDetails.decision`
 *   (`declined` is what keeps a guest from instant-booking again, `expired` is not held against them).
 *
 * Each outcome texts the guest from the workspace work number (email from the work email when they gave
 * one) and emits `channel_booking` / `short_stay_confirmed|declined|expired` to the owner and teammates.
 * Everything after the swap is notification and never undoes it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { renderOwnerBookingEmail, sendOwnerBookingEmail } from "@/lib/channel-booking-events.server";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";
import {
  CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
  ROOM_DATE_BLOCK_RECORD_TYPE,
} from "@/lib/portal-schedule-record-scope";
import { postResendEmail } from "@/lib/resend-delivery.server";
import {
  guestStayApprovedText,
  guestStayDeclinedText,
  guestStayExpiredText,
  isShortStayRequestSource,
} from "@/lib/short-stay/guest-stays";
import { ensureGuestStayCharge } from "@/lib/short-stay/stay-charge.server";
import { raiseRequestedStayAddOnCharges } from "@/lib/short-stay/stay-add-ons.server";
import { loadOwnerIdentity, loadStayLabels } from "@/lib/short-stay/stay-labels.server";
import { shortStayRangeLabel } from "@/lib/short-stay-request";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";

export type ShortStayHoldDecision = "approve" | "decline" | "expire";

export type ShortStayHoldDecisionResult =
  | { ok: true; outcome: "confirmed" | "cancelled"; decision: ShortStayHoldDecision; chargeCreated: boolean }
  | { ok: false; status: 404 | 409 | 503; error: string };

const EVENT_FOR: Record<ShortStayHoldDecision, "short_stay_confirmed" | "short_stay_declined" | "short_stay_expired"> = {
  approve: "short_stay_confirmed",
  decline: "short_stay_declined",
  expire: "short_stay_expired",
};
const HEADLINE_FOR: Record<ShortStayHoldDecision, string> = {
  approve: "Short stay confirmed",
  decline: "Short stay declined",
  expire: "Short-stay request expired",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function decideShortStayHold(
  db: SupabaseClient,
  input: { blockId: string; decision: ShortStayHoldDecision; now?: Date },
): Promise<ShortStayHoldDecisionResult> {
  const { blockId, decision } = input;
  const now = (input.now ?? new Date()).toISOString();
  const { data: record, error: readError } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, record_type, row_data")
    .eq("id", blockId)
    .maybeSingle();
  if (readError) return { ok: false, status: 503, error: "We couldn't read that booking. Try again in a minute." };
  if (!record) return { ok: false, status: 404, error: "Booking not found." };
  const row = asRecord(record.row_data);
  const details = asRecord(row.stayDetails);
  if (record.record_type !== ROOM_DATE_BLOCK_RECORD_TYPE || row.bookingStatus !== "hold" || !isShortStayRequestSource(details.source)) {
    return { ok: false, status: 409, error: "That request was already answered." };
  }

  const { holdExpiresAt: _holdExpiresAt, ...keptDetails } = details;
  void _holdExpiresAt;
  const next: Record<string, unknown> =
    decision === "approve"
      ? {
          ...row,
          bookingStatus: "confirmed",
          reason: "Short-stay confirmed",
          stayDetails: { ...keptDetails, decision: "approved", confirmedAt: now },
        }
      : {
          ...row,
          bookingStatus: "cancelled",
          recordType: CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
          reason: decision === "decline" ? "Declined by host" : "Request expired",
          stayDetails: { ...keptDetails, decision: decision === "decline" ? "declined" : "expired", decidedAt: now },
        };

  // Compare-and-swap on the status we read: the loser of a race changes nothing.
  const { data: swapped, error: swapError } = await db
    .from("portal_schedule_records")
    .update({
      record_type: decision === "approve" ? ROOM_DATE_BLOCK_RECORD_TYPE : CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
      row_data: next,
      updated_at: now,
    })
    .eq("id", blockId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
    .filter("row_data->>bookingStatus", "eq", "hold")
    .select("id");
  if (swapError) {
    const code = String((swapError as { code?: string }).code ?? "");
    if (["P4001", "40001", "40P01"].includes(code)) {
      return { ok: false, status: 409, error: "Those nights were taken before this could be confirmed." };
    }
    return { ok: false, status: 503, error: "We couldn't save that. Try again in a minute." };
  }
  if (!swapped || swapped.length === 0) return { ok: false, status: 409, error: "That request was already answered." };

  const ownerId = String(record.manager_user_id ?? "").trim();
  const propertyId = String(record.property_id ?? row.propertyId ?? "").trim();
  const labels = await loadStayLabels(db, propertyId, String(row.roomId ?? ""));

  let chargeCreated = false;
  if (decision === "approve") {
    const charge = await ensureGuestStayCharge(db, { blockId, ownerId, propertyId, propertyLabel: labels.propertyLabel, row: next });
    chargeCreated = charge.ok && charge.created;
    // Add-ons the guest asked for while this was a hold (stored `requested`) get their charges now.
    await raiseRequestedStayAddOnCharges(db, { blockId, now: input.now });
  }

  await notifyOfDecision(db, { decision, blockId, ownerId, propertyId, row: next, labels }).catch(() => undefined);
  return { ok: true, outcome: decision === "approve" ? "confirmed" : "cancelled", decision, chargeCreated };
}

export { loadOwnerIdentity, loadStayLabels };

async function notifyOfDecision(
  db: SupabaseClient,
  input: {
    decision: ShortStayHoldDecision;
    blockId: string;
    ownerId: string;
    propertyId: string;
    row: Record<string, unknown>;
    labels: { propertyLabel: string; roomLabel: string };
  },
): Promise<void> {
  const { decision, blockId, ownerId, propertyId, row, labels } = input;
  const checkIn = String(row.checkIn ?? "");
  const checkOut = String(row.checkOut ?? "");
  const nights = Number(row.quotedNights) || 0;
  const total = Number.isFinite(Number(row.quotedTotal)) ? Number(row.quotedTotal) : null;
  const portalUrl = residentPortalUrl("stays");
  const stay = { ...labels, checkIn, checkOut, nights, total };
  const text =
    decision === "approve"
      ? guestStayApprovedText(stay, portalUrl)
      : decision === "decline"
        ? guestStayDeclinedText(stay, portalUrl)
        : guestStayExpiredText(stay, portalUrl);
  const phone = typeof row.residentPhone === "string" ? row.residentPhone : "";
  const email = typeof row.residentEmail === "string" ? row.residentEmail.trim().toLowerCase() : "";
  const event = EVENT_FOR[decision];

  if (phone) {
    await enqueueOwnerSms(
      {
        managerUserId: ownerId,
        actorUserId: ownerId,
        recipientPhone: phone,
        recipientEmail: email || undefined,
        body: text,
        sendClass: "transactional",
        purpose: event,
        counterpartyRole: "prospect",
        propertyId,
        dedupeKey: `${event}:${blockId}`,
      },
      db,
    ).catch(() => undefined);
  }
  if (email && !shouldSkipOutboundEmail(email) && process.env.RESEND_API_KEY?.trim()) {
    await postResendEmail({
      apiKey: process.env.RESEND_API_KEY.trim(),
      actorUserId: ownerId,
      payload: {
        from: await managerOutboundFromHeader(db, ownerId),
        to: [email],
        subject: `${decision === "approve" ? "Confirmed" : decision === "decline" ? "Not confirmed" : "Request expired"}: ${labels.roomLabel} at ${labels.propertyLabel}`,
        text,
      },
      effectSummary: "Short-stay answer email was captured for SMS test mode.",
      metadata: { recipients: 1 },
    }).catch(() => undefined);
  }

  await emitShortStayTeamNotice(db, {
    event,
    headline: HEADLINE_FOR[decision],
    blockId,
    ownerId,
    propertyId,
    row,
    labels,
  });
}

/** `channel_booking` / `short_stay_confirmed|declined|expired` to the owner and teammates (the notice spine). */
export async function emitShortStayTeamNotice(
  db: SupabaseClient,
  input: {
    event: "short_stay_confirmed" | "short_stay_declined" | "short_stay_expired";
    headline: string;
    blockId: string;
    ownerId: string;
    propertyId: string;
    row: Record<string, unknown>;
    labels: { propertyLabel: string; roomLabel: string };
    /** The owner's address and name when the caller already read them (one read per request, not per range). */
    owner?: { email: string; name: string };
  },
): Promise<void> {
  const { event, headline, blockId, ownerId, propertyId, row, labels } = input;
  const checkIn = String(row.checkIn ?? "");
  const checkOut = String(row.checkOut ?? "");
  const nights = Number(row.quotedNights) || 0;
  const owner = input.owner ?? (await loadOwnerIdentity(db, ownerId));
  const ownerEmail = owner.email;
  if (!ownerEmail) return;
  const guestName = typeof row.residentName === "string" ? row.residentName : "Guest";
  const stayLabel = `${shortStayRangeLabel(checkIn, checkOut)} (${nights} ${nights === 1 ? "night" : "nights"})`;
  const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/bookings/${encodeURIComponent(`block:${blockId}`)}`;
  const line = [headline, labels.propertyLabel, labels.roomLabel, stayLabel, guestName].join(" · ");
  await emitActionEvent(db, {
    eventId: `${event}:${blockId}`,
    domain: "channel_booking",
    event,
    managerUserId: ownerId,
    entityId: blockId,
    category: "tours",
    senderUserId: ownerId,
    senderEmail: ownerEmail,
    senderName: owner.name || undefined,
    payload: { propertyId, roomId: String(row.roomId ?? ""), blockId, start: checkIn, end: checkOut, nights },
    templateContext: { propertyTitle: labels.propertyLabel, roomLabel: labels.roomLabel, stayLabel, url },
    recipients: [{ audience: "manager", userId: ownerId, rendered: { subject: headline, text: `${line}\n\n${url}`, smsText: `${line}\n${url}` } }],
  }).catch(() => undefined);
  // A confirmed short stay IS a booking, so the owner is mailed whatever their alert destination says -
  // the same always-email a booking typed in PropLane or read off a channel feed gets, on the same
  // idempotency key as the notice above, so a destination of email sends exactly one mail.
  if (event !== "short_stay_confirmed") return;
  const guests = Number(row.guests) || 0;
  await sendOwnerBookingEmail(db, {
    ownerUserId: ownerId,
    propertyId,
    eventId: `${event}:${blockId}`,
    bookingKey: `block:${blockId}`,
    ...renderOwnerBookingEmail({
      created: true,
      propertyLabel: labels.propertyLabel,
      roomLabel: labels.roomLabel,
      guest: guestName,
      stayLabel: guests ? `${stayLabel} · ${guests} ${guests === 1 ? "guest" : "guests"}` : stayLabel,
      sourceLabel: "PropLane · guest booking",
    }),
  });
}
