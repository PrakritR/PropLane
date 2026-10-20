import "server-only";

/**
 * A guest's CONFIRMED short stay that is still unpaid 24 hours after it was confirmed gives its nights back.
 * `expireShortStayHolds` only releases unconfirmed holds, so without this a stay the guest never pays for
 * blocks the room forever.
 *
 * Which stays: a guest's own request (public card, guest portal or text; a manager-typed booking is never
 * touched), confirmed more than `SHORT_STAY_PAY_HOURS` ago, check-in still ahead, whose `stay_total` charge is
 * still `pending` or `failed`. A charge that is paid, processing (a bank debit clearing), part-paid or missing
 * keeps the stay.
 *
 * What it does, once: moves the block to `cancelled_room_date_block` with `stayDetails.decision:
 * "unpaid_expired"` (compare-and-swap on the stored status, so two cron runs or an Approve race resolve to one
 * outcome), cancels the unpaid charge, ends the pay link, texts the guest from the work number, and tells the
 * team (`channel_booking` / `short_stay_unpaid_expired`, idempotent on the block id).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { revokePhoneBoundLinksForTarget } from "@/lib/one-number/links.server";
import {
  CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
  ROOM_DATE_BLOCK_RECORD_TYPE,
} from "@/lib/portal-schedule-record-scope";
import { pacificTodayKey } from "@/lib/room-availability-range";
import {
  SHORT_STAY_PAY_HOURS,
  guestStayUnpaidReleasedText,
  isShortStayRequestSource,
} from "@/lib/short-stay/guest-stays";
import { emitShortStayTeamNotice } from "@/lib/short-stay/hold-decisions.server";
import { loadStayLabels } from "@/lib/short-stay/stay-labels.server";
import { guestStayChargeId } from "@/lib/short-stay/stay-charge.server";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";

type Row = Record<string, unknown>;
const asRecord = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

export type UnpaidStayExpiryResult = { checked: number; released: number; kept: number; failed: number; errors: string[] };

/** Pure: is this stored block a confirmed guest stay whose payment window has run out? */
export function unpaidConfirmationDue(row: Row, now: Date, today: string): boolean {
  if (row.bookingStatus !== "confirmed") return false;
  const details = asRecord(row.stayDetails);
  if (!isShortStayRequestSource(details.source)) return false;
  const confirmedAt = Date.parse(String(details.confirmedAt ?? ""));
  if (!Number.isFinite(confirmedAt)) return false;
  if (now.getTime() - confirmedAt < SHORT_STAY_PAY_HOURS * 3_600_000) return false;
  // A stay that has started or is over is not a nights-back question any more.
  return String(row.checkIn ?? "") > today;
}

export async function releaseUnpaidConfirmedStays(db: SupabaseClient, now = new Date()): Promise<UnpaidStayExpiryResult> {
  const result: UnpaidStayExpiryResult = { checked: 0, released: 0, kept: 0, failed: 0, errors: [] };
  const today = pacificTodayKey(now);
  const due: Array<{ id: string; managerUserId: string; propertyId: string; row: Row }> = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("id, manager_user_id, property_id, row_data")
      .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
      .order("id")
      .range(offset, offset + 499);
    if (error) throw new Error(`Could not list confirmed short stays: ${error.message}`);
    for (const record of (data ?? []) as Row[]) {
      const row = asRecord(record.row_data);
      if (!unpaidConfirmationDue(row, now, today)) continue;
      due.push({ id: String(record.id), managerUserId: String(record.manager_user_id ?? ""), propertyId: String(record.property_id ?? row.propertyId ?? ""), row });
    }
    if ((data ?? []).length < 500) break;
  }
  result.checked = due.length;

  for (const stay of due) {
    try {
      const chargeId = guestStayChargeId(stay.id);
      const { data: charge } = await db.from("portal_household_charge_records").select("id, status, row_data, manager_user_id").eq("id", chargeId).maybeSingle();
      const status = String((charge as Row | null)?.status ?? "");
      if (!charge || (status !== "pending" && status !== "failed")) {
        result.kept += 1;
        continue;
      }
      const nowIso = now.toISOString();
      const { confirmedAt: _confirmedAt, ...keptDetails } = asRecord(stay.row.stayDetails);
      void _confirmedAt;
      const next: Row = {
        ...stay.row,
        bookingStatus: "cancelled",
        recordType: CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
        reason: "Unpaid stay released",
        stayDetails: { ...keptDetails, confirmedAt: asRecord(stay.row.stayDetails).confirmedAt, decision: "unpaid_expired", decidedAt: nowIso },
      };
      const { data: swapped, error: swapError } = await db
        .from("portal_schedule_records")
        .update({ record_type: CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE, row_data: next, updated_at: nowIso })
        .eq("id", stay.id)
        .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
        .filter("row_data->>bookingStatus", "eq", "confirmed")
        .select("id");
      if (swapError) throw new Error(swapError.message);
      if (!swapped || swapped.length === 0) {
        result.kept += 1; // another run, or the host, got there first
        continue;
      }

      const chargeRow = asRecord((charge as Row).row_data);
      await db
        .from("portal_household_charge_records")
        .update({ status: "cancelled", row_data: { ...chargeRow, status: "cancelled", cancelledAt: nowIso, cancelReason: "Unpaid short stay released" }, updated_at: nowIso })
        .eq("id", chargeId)
        .in("status", ["pending", "failed"]);
      await revokePhoneBoundLinksForTarget(db, { targetType: "charge", targetId: chargeId, purpose: "rent", now }).catch(() => 0);

      const labels = await loadStayLabels(db, stay.propertyId, String(stay.row.roomId ?? ""));
      const phone = typeof stay.row.residentPhone === "string" ? stay.row.residentPhone : "";
      const nights = Number(stay.row.quotedNights) || 0;
      const total = Number.isFinite(Number(stay.row.quotedTotal)) ? Number(stay.row.quotedTotal) : null;
      if (phone) {
        await enqueueOwnerSms(
          {
            managerUserId: stay.managerUserId,
            actorUserId: stay.managerUserId,
            recipientPhone: phone,
            body: guestStayUnpaidReleasedText(
              { ...labels, checkIn: String(stay.row.checkIn ?? ""), checkOut: String(stay.row.checkOut ?? ""), nights, total },
              residentPortalUrl("stays"),
            ),
            sendClass: "transactional",
            purpose: "short_stay_unpaid_expired",
            counterpartyRole: "prospect",
            propertyId: stay.propertyId,
            dedupeKey: `short_stay_unpaid_expired:${stay.id}`,
          },
          db,
        ).catch(() => undefined);
      }
      await emitShortStayTeamNotice(db, {
        event: "short_stay_unpaid_expired",
        headline: "Short stay released, unpaid",
        blockId: stay.id,
        ownerId: stay.managerUserId,
        propertyId: stay.propertyId,
        row: next,
        labels,
      }).catch(() => undefined);
      result.released += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push(`${stay.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
