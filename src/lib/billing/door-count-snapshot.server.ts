import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerDoorCount, type ListingDoorBreakdown } from "@/lib/billing/door-count.server";

/**
 * Per-account, per-billing-period door snapshots
 * (`supabase/migrations/20260922010000_door_count_snapshot.sql`).
 *
 * Billing reads THIS table, never a live count (`loadManagerDoorCount`) —
 * a listing edited mid-cycle must never move a bill that already went out.
 * This file is the only writer; it is service-role only, so a snapshot is
 * always taken or refreshed from the server, never from a client request body.
 */

const MANAGER_DOOR_COUNT_SNAPSHOTS_TABLE = "manager_door_count_snapshots";

/** `YYYY-MM-DD` — the billing period is identified by its start date alone. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DoorCountSnapshot = {
  managerUserId: string;
  periodStart: string;
  totalDoors: number;
  breakdown: ListingDoorBreakdown[];
  createdAt: string;
};

export type TakeDoorCountSnapshotResult = { ok: true; snapshot: DoorCountSnapshot } | { ok: false; error: string };

type SnapshotRow = {
  manager_user_id: string;
  period_start: string;
  total_doors: number;
  breakdown: unknown;
  created_at: string;
};

function toSnapshot(row: SnapshotRow): DoorCountSnapshot {
  return {
    managerUserId: row.manager_user_id,
    periodStart: row.period_start,
    totalDoors: row.total_doors,
    breakdown: Array.isArray(row.breakdown) ? (row.breakdown as ListingDoorBreakdown[]) : [],
    createdAt: row.created_at,
  };
}

/**
 * Take (or refresh) the door-count snapshot for `managerUserId` /
 * `periodStart`. Idempotent on that pair: the table's unique index on
 * `(manager_user_id, period_start)` means calling this any number of times
 * for the same account and period upserts ONE row rather than accumulating
 * duplicates, and calling it again with unchanged underlying listings leaves
 * the stored total and breakdown unchanged.
 *
 * Recomputes from the LIVE count every call — that is the "refresh" half.
 * Callers who want the frozen number a bill was issued against must read the
 * row this returns (or the table directly) rather than calling this again.
 */
export async function takeManagerDoorCountSnapshot(
  db: SupabaseClient,
  managerUserId: string,
  periodStart: string,
): Promise<TakeDoorCountSnapshotResult> {
  const trimmedManager = managerUserId.trim();
  if (!trimmedManager) return { ok: false, error: "managerUserId is required" };

  const trimmedPeriod = periodStart.trim();
  if (!ISO_DATE_RE.test(trimmedPeriod)) {
    return { ok: false, error: "periodStart must be an ISO date (YYYY-MM-DD)" };
  }

  const counted = await loadManagerDoorCount(db, trimmedManager);
  if (!counted.ok) return { ok: false, error: counted.error };

  const { data, error } = await db
    .from(MANAGER_DOOR_COUNT_SNAPSHOTS_TABLE)
    .upsert(
      {
        manager_user_id: trimmedManager,
        period_start: trimmedPeriod,
        total_doors: counted.totalDoors,
        breakdown: counted.breakdown,
      },
      { onConflict: "manager_user_id,period_start" },
    )
    .select("manager_user_id, period_start, total_doors, breakdown, created_at")
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, snapshot: toSnapshot(data as SnapshotRow) };
}
