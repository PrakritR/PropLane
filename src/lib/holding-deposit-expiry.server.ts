import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { effectiveHoldExpiresAt } from "@/lib/holding-hold";
import { CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import { reserveRoomForHold } from "@/lib/holding-room-block.server";
import { emitHoldingDepositExpired } from "@/lib/domain-action-events.server";

type ChargeRow = { id: string; manager_user_id: string | null; resident_email: string | null; status: string; row_data: HouseholdCharge };

export type HoldingDepositExpiryResult = {
  checked: number;
  expired: number;
  creditedOnSign: number;
  failed: number;
  errors: string[];
};

/** True when the resident signed a lease between the hold's payment and its deadline (so the hold credited the deposit). */
async function leaseSignedInWindow(db: SupabaseClient, managerUserId: string, email: string, fromMs: number, toMs: number): Promise<boolean> {
  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .eq("resident_email", email)
    .limit(50);
  if (error) throw new Error(`lease read: ${error.message}`);
  for (const row of data ?? []) {
    const lease = row.row_data as { residentSignature?: { signedAtIso?: string }; signedAtIso?: string } | null;
    const signedAt = Date.parse(lease?.residentSignature?.signedAtIso ?? lease?.signedAtIso ?? "");
    if (Number.isFinite(signedAt) && signedAt >= fromMs && signedAt <= toMs) return true;
  }
  return false;
}

/** Give the room back: the hold block becomes a cancelled block, so the room is available again. Never touches a confirmed booking. */
async function releaseRoomHold(db: SupabaseClient, blockId: string, nowIso: string, reason = "Hold fee expired"): Promise<void> {
  const { data, error } = await db.from("portal_schedule_records").select("row_data, manager_user_id").eq("id", blockId).maybeSingle();
  if (error) throw new Error(`room hold read: ${error.message}`);
  const block = data?.row_data as { bookingStatus?: string } | null;
  if (!block || block.bookingStatus === "confirmed" || block.bookingStatus === "cancelled") return;
  const { error: writeError } = await db.from("portal_schedule_records").upsert(
    { id: blockId, manager_user_id: data?.manager_user_id, record_type: CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE, row_data: { ...block, bookingStatus: "cancelled", reason }, updated_at: nowIso },
    { onConflict: "id" },
  );
  if (writeError) throw new Error(`room hold release: ${writeError.message}`);
}

/**
 * Hourly. A paid hold fee whose 7 days ran out:
 *  - lease signed inside the window -> stamp `holdCreditedAt` (the deposit path already netted it) and leave it alone;
 *  - otherwise -> stamp `holdExpiredAt`, release the room hold it carries (`roomHoldBlockId`, when it has one) so the
 *    room is available again, and tell the manager. The money is KEPT per the holding-deposit policy: status stays
 *    `paid`, nothing is refunded and no ledger line moves.
 * Idempotent: a stamped row is skipped; the compare-and-swap on `updated_at` refuses a concurrent edit.
 */
export async function expireHoldingDeposits(db: SupabaseClient, now: Date = new Date()): Promise<HoldingDepositExpiryResult> {
  const result: HoldingDepositExpiryResult = { checked: 0, expired: 0, creditedOnSign: 0, failed: 0, errors: [] };
  const rows: ChargeRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db
      .from("portal_household_charge_records")
      .select("id, manager_user_id, resident_email, status, row_data")
      .eq("kind", "holding_deposit")
      .eq("status", "paid")
      .order("id")
      .range(offset, offset + 499);
    if (error) throw new Error(`Could not list holding deposits: ${error.message}`);
    rows.push(...((data ?? []) as ChargeRow[]));
    if ((data ?? []).length < 500) break;
  }
  for (const row of rows) {
    const charge = row.row_data;
    if (!charge || charge.holdExpiredAt || charge.holdCreditedAt) continue;
    const expiresIso = effectiveHoldExpiresAt({ ...charge, status: "paid" });
    if (!expiresIso) continue;
    const expired = now.getTime() >= Date.parse(expiresIso);
    // Inside the window only a hold carrying a room block can change (a signed lease takes the room over).
    if (!expired && !charge.roomHoldBlockId) continue;
    result.checked += 1;
    try {
      const managerId = row.manager_user_id ?? "";
      const email = (row.resident_email ?? charge.residentEmail ?? "").trim().toLowerCase();
      const stamp = now.toISOString();
      if (managerId && email) {
        const paidMs = Date.parse(charge.paidAt ?? "") || 0;
        if (await leaseSignedInWindow(db, managerId, email, paidMs, Date.parse(expiresIso))) {
          await db.from("portal_household_charge_records")
            .update({ row_data: { ...charge, holdCreditedAt: stamp }, updated_at: stamp })
            .eq("id", row.id).eq("status", "paid");
          // The lease booking takes the room over: the hold's own block goes.
          if (charge.roomHoldBlockId) await releaseRoomHold(db, charge.roomHoldBlockId, stamp, "Lease signed");
          result.creditedOnSign += 1;
          continue;
        }
      }
      if (!expired) {
        result.checked -= 1;
        continue;
      }
      const { data: saved, error: saveError } = await db.from("portal_household_charge_records")
        .update({ row_data: { ...charge, holdExpiresAt: expiresIso, holdExpiredAt: stamp }, updated_at: stamp })
        .eq("id", row.id).eq("status", "paid").select("id").maybeSingle();
      if (saveError) throw new Error(saveError.message);
      if (!saved) continue;
      const blockId = charge.roomHoldBlockId?.trim();
      if (blockId) await releaseRoomHold(db, blockId, stamp);
      if (managerId) await emitHoldingDepositExpired(db, { managerUserId: managerId, charge: { ...charge, id: row.id, holdExpiredAt: stamp } }).catch(() => undefined);
      result.expired += 1;
    } catch (e) {
      result.failed += 1;
      result.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

/** Tell the holder (and the manager) a paid hold is in place. Idempotent on the charge id; never blocks the payment. */
export async function notifyHoldPlaced(db: SupabaseClient, managerUserId: string, charge: HouseholdCharge): Promise<void> {
  if (charge.kind !== "holding_deposit" || charge.status !== "paid" || !managerUserId) return;
  // The paid hold reserves the room first (named booking), then the holder hears about it.
  const blockId = await reserveRoomForHold(db, managerUserId, charge).catch((e) => {
    console.error("[hold-room-block]", e instanceof Error ? e.message : "failed");
    return null;
  });
  if (blockId) charge = { ...charge, roomHoldBlockId: blockId };
  const expires = effectiveHoldExpiresAt(charge);
  if (!expires) return;
  try {
    const { emitHoldPlaced } = await import("@/lib/guest-notices.server");
    await emitHoldPlaced(db, {
      managerUserId,
      holdId: charge.id,
      holderEmail: charge.residentEmail,
      holderUserId: charge.residentUserId ?? undefined,
      propertyId: charge.propertyId || undefined,
      facts: {
        amountLabel: (charge.amountLabel || "$100").replace(/\.00$/, ""),
        roomLabel: charge.roomLabel?.trim() || charge.propertyLabel || "your room",
        expiresLabel: new Date(expires).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      },
    });
  } catch (e) {
    console.error("[hold-placed]", e instanceof Error ? e.message : "failed");
  }
}
