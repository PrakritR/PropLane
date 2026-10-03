import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HouseholdCharge } from "@/lib/household-charges";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { releaseShortStayHold } from "@/lib/short-stay-booking.server";

type HoldRow = {
  id: string;
  row_data: {
    bookingStatus?: string;
    stayDetails?: { holdExpiresAt?: string };
  };
};

/** Active short-stay holds whose 15-minute checkout window has passed. */
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

/** Release expired checkout holds and cancel their unpaid stay charges. */
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
