import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HouseholdCharge } from "@/lib/household-charges";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { releaseShortStayHold } from "@/lib/short-stay-booking.server";
import { decideShortStayHold } from "@/lib/short-stay/hold-decisions.server";

type HoldRow = {
  id: string;
  row_data: {
    bookingStatus?: string;
    stayDetails?: { holdExpiresAt?: string };
  };
};

/** Active short-stay holds whose window has passed: a guest request's 24 hours, or a legacy checkout's 15 minutes. */
export async function listExpiredShortStayHolds(db: SupabaseClient, now = new Date()): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("id, row_data")
      .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE)
      .order("id")
      .range(offset, offset + 499);
    if (error) throw new Error(`Could not list short-stay holds: ${error.message}`);
    for (const row of (data ?? []) as HoldRow[]) {
      const block = row.row_data;
      if (block?.bookingStatus !== "hold") continue;
      const expires = block.stayDetails?.holdExpiresAt;
      if (!expires || now.getTime() < Date.parse(expires)) continue;
      ids.push(String(row.id));
    }
    if ((data ?? []).length < 500) break;
  }
  return ids;
}

async function cancelPendingChargesForBooking(db: SupabaseClient, bookingId: string): Promise<void> {
  const { data } = await db
    .from("portal_household_charge_records")
    .select("id, status, row_data, manager_user_id, resident_email")
    .filter("row_data->>shortStayBookingId", "eq", bookingId);
  const now = new Date().toISOString();
  for (const row of data ?? []) {
    const charge = row.row_data as HouseholdCharge & { shortStayBookingId?: string };
    if (charge.shortStayBookingId?.trim() !== bookingId) continue;
    if (row.status === "paid" || row.status === "processing") continue;
    await db.from("portal_household_charge_records").upsert(
      {
        id: row.id,
        manager_user_id: charge.managerUserId,
        resident_email: charge.residentEmail?.trim().toLowerCase(),
        status: "cancelled",
        row_data: { ...charge, status: "cancelled", cancelledAt: now, cancelReason: "Short-stay hold expired" },
        updated_at: now,
      },
      { onConflict: "id" },
    );
  }
}

export type ShortStayHoldExpiryResult = {
  checked: number;
  released: number;
  failed: number;
  errors: string[];
};

/**
 * Expire the holds whose window has passed. A guest's request (`stayDetails.source` is a request source)
 * is answered through `decideShortStayHold` - cancelled, the guest texted, the team told. A legacy
 * pay-to-hold checkout hold is released and its unpaid stay charge cancelled, as before.
 */
export async function expireShortStayHolds(db: SupabaseClient, now = new Date()): Promise<ShortStayHoldExpiryResult> {
  const bookingIds = await listExpiredShortStayHolds(db, now);
  const result: ShortStayHoldExpiryResult = {
    checked: bookingIds.length,
    released: 0,
    failed: 0,
    errors: [],
  };
  for (const bookingId of bookingIds) {
    try {
      const answered = await decideShortStayHold(db, { blockId: bookingId, decision: "expire", now });
      if (answered.ok) {
        result.released += 1;
        continue;
      }
      // A read/write failure is retried on the next run; a legacy release must never cancel a guest request.
      if (answered.status !== 409) throw new Error(answered.error);
      // Not a guest request (or already answered): fall through to the legacy release, which no-ops on an answered hold.
      await releaseShortStayHold(db, bookingId);
      await cancelPendingChargesForBooking(db, bookingId);
      result.released += 1;
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push(`${bookingId}: ${message}`);
    }
  }
  return result;
}
