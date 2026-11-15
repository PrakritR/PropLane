import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { effectiveHoldExpiresAt } from "@/lib/holding-hold";
import { loadPropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import { stampStayRow } from "@/lib/bookings/stay-stamp";
import { roomDateBlockNameError } from "@/lib/channel-calendar/room-block-name-rule";
import { ROOM_DATE_BLOCK_RECORD_TYPE, roomDateBlockRecordId } from "@/lib/portal-schedule-record-scope";
import { parseRoomChoiceValue } from "@/lib/rental-application/room-choice-value";

/** The block id for one hold fee: deterministic, so placing it twice is one block. */
export function holdRoomBlockId(ownerId: string, chargeId: string): string {
  return roomDateBlockRecordId(ownerId, `hold_${chargeId.replace(/[^A-Za-z0-9_-]/g, "_")}`);
}

const day = (iso: string) => iso.slice(0, 10);

/**
 * A paid hold fee reserves the room: a NAMED booking ("Hold — <applicant>") from the paid date to the hold's
 * deadline (check-out is exclusive, so the room is free again that day), written through the same `room_date_block`
 * shape the bookings core stores. Server-owned and idempotent on the charge id. It only acts when the application
 * names a room and no other booking already overlaps those nights (a clash never blocks the payment, it just leaves
 * the hold without a block). Stamps `roomHoldBlockId` on the charge and returns the block id.
 */
export async function reserveRoomForHold(db: SupabaseClient, managerUserId: string, charge: HouseholdCharge): Promise<string | null> {
  if (charge.kind !== "holding_deposit" || charge.status !== "paid" || !charge.applicationId?.trim()) return null;
  if (charge.roomHoldBlockId) return charge.roomHoldBlockId;
  const expires = effectiveHoldExpiresAt(charge);
  const paidAt = charge.paidAt;
  if (!expires || !paidAt) return null;

  const { data: app } = await db.from("manager_application_records").select("row_data").eq("id", charge.applicationId.trim()).maybeSingle();
  const appRow = app?.row_data as { assignedRoomChoice?: string; assignedPropertyId?: string; propertyId?: string; name?: string; application?: { roomChoice1?: string } } | null;
  const choice = parseRoomChoiceValue(appRow?.assignedRoomChoice?.trim() || appRow?.application?.roomChoice1?.trim() || "");
  const roomId = choice.listingRoomId?.trim() ?? "";
  const propertyId = (choice.propertyId || appRow?.assignedPropertyId || appRow?.propertyId || charge.propertyId || "").trim();
  if (!roomId || !propertyId) return null;

  const name = `Hold — ${(charge.residentName || appRow?.name || "applicant").trim()}`;
  if (roomDateBlockNameError({ residentName: name })) return null;
  const { data: property } = await db.from("manager_property_records").select("manager_user_id").eq("id", propertyId).maybeSingle();
  const ownerId = String(property?.manager_user_id ?? managerUserId).trim() || managerUserId;
  const id = holdRoomBlockId(ownerId, charge.id);
  const checkIn = day(paidAt);
  const checkOut = day(expires);
  if (checkOut <= checkIn) return null;

  const { data: existingRows, error: readError } = await db
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("property_id", propertyId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE);
  if (readError) throw new Error(`room blocks read: ${readError.message}`);
  const blocks = (existingRows ?? []) as Array<{ id: string; row_data: { roomId?: string; checkIn?: string; checkOut?: string; openEnded?: boolean; bookingStatus?: string } }>;
  const already = blocks.some((b) => b.id === id);
  if (!already) {
    const clash = blocks.some((b) => {
      const r = b.row_data;
      if (!r || r.bookingStatus === "cancelled" || (r.roomId && r.roomId !== roomId)) return false;
      const start = r.checkIn ?? "";
      const end = r.checkOut ?? "";
      return r.openEnded ? checkOut > start : checkIn < end && start < checkOut;
    });
    if (clash) return null;
    const clock = await loadPropertyStayClock(db, propertyId);
    const now = new Date().toISOString();
    const stamped = stampStayRow(
      {
        id, propertyId, roomId, checkIn, checkOut, openEnded: false, reason: "Hold fee", residentName: name,
        bookingStatus: "hold", holdChargeId: charge.id, createdAt: now, createdByUserId: managerUserId, recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
      },
      null,
      clock,
    );
    const row = { ...stamped.rowData, startsAt: stamped.startsAt ?? `${checkIn}T00:00:00`, endsAt: stamped.endsAt ?? `${checkOut}T00:00:00` };
    const { error } = await db.from("portal_schedule_records").insert({
      id, manager_user_id: ownerId, property_id: propertyId, record_type: ROOM_DATE_BLOCK_RECORD_TYPE,
      starts_at: row.startsAt, ends_at: row.endsAt, row_data: row, updated_at: now,
    });
    if (error && error.code !== "23505") throw new Error(`room hold write: ${error.message}`);
  }
  const stamp = new Date().toISOString();
  await db.from("portal_household_charge_records")
    .update({ row_data: { ...charge, roomHoldBlockId: id }, updated_at: stamp })
    .eq("id", charge.id).eq("status", "paid");
  return id;
}
