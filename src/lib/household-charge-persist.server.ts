import { isDeepStrictEqual } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
import {
  householdChargeLedgerFingerprint,
  reconcileDuplicateChargeList,
  syncLedgerChargeEntry,
} from "@/lib/reports/ledger-sync";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";

export type HouseholdChargeWriteRow = {
  id: string;
  manager_user_id: string | null;
  resident_user_id: string | null;
  resident_email: string | null;
  property_id: string | null;
  kind: string | null;
  status: string | null;
  row_data: Record<string, unknown>;
  updated_at: string;
};

export type HouseholdChargeWriteContext = {
  /** Who is writing: the signed-in user on the route, the row's own manager in the cron. */
  actor: { id: string; role: string };
  now: string;
  /** Ids the caller mirrored (batch scope for the duplicate reconcile). */
  chargeIds: string[];
  previousStatusById: Map<string, string | null>;
  existingOwnerById: Map<string, string | null>;
  existingUpdatedAtById: Map<string, string | null>;
  existingRecordById: Map<string, Record<string, unknown>>;
  existingLedgerFingerprintById: Map<string, string>;
};

/**
 * The ONE write path for household charge rows: insert-only for a new id,
 * compare-and-swap update for an existing one, then the batch duplicate
 * reconcile, ledger/GL sync and transition events for the rows that actually
 * landed. Used by POST /api/portal-household-charges and by the daily
 * recurring-rent cron, so a generated row is persisted exactly like a mirrored one.
 */
export async function persistHouseholdChargeRows(
  db: SupabaseClient,
  mappedRows: HouseholdChargeWriteRow[],
  ctx: HouseholdChargeWriteContext,
): Promise<{ persistedRows: HouseholdChargeWriteRow[]; chargeWriteError: string | null }> {
  const { actor, now, chargeIds, previousStatusById, existingOwnerById, existingUpdatedAtById, existingRecordById, existingLedgerFingerprintById } = ctx;
  const persistedRows: HouseholdChargeWriteRow[] = [];
  let chargeWriteError: string | null = null;
  for (const row of mappedRows) {
    if (existingOwnerById.has(row.id)) {
      const stored = existingRecordById.get(row.id);
      if (stored && isDeepStrictEqual(stored.row_data, row.row_data) &&
          stored.manager_user_id === row.manager_user_id && stored.resident_user_id === row.resident_user_id &&
          stored.resident_email === row.resident_email && stored.property_id === row.property_id &&
          stored.kind === row.kind && stored.status === row.status) continue;
      const expectedStatus = previousStatusById.get(row.id);
      const expectedUpdatedAt = existingUpdatedAtById.get(row.id);
      // A missing version cannot safely be compared; a subsequent load
      // can recover this row without risking a provider settlement.
      if (!expectedStatus || !expectedUpdatedAt) continue;
      const { data, error } = await db.from("portal_household_charge_records")
        .update(row)
        .eq("id", row.id)
        .eq("status", expectedStatus)
        .eq("updated_at", expectedUpdatedAt)
        .select("id");
      if (error) { chargeWriteError = error.message; break; }
      if ((data ?? []).length > 0) persistedRows.push(row);
    } else {
      // Insert-only: a concurrent provider/manager writer may have created
      // this id after our read. Never turn that row into an upsert target.
      const { data, error } = await db.from("portal_household_charge_records").insert(row).select("id");
      if (error?.code === "23505") continue;
      if (error) { chargeWriteError = error.message; break; }
      if ((data ?? []).length > 0) persistedRows.push(row);
    }
  }
  if (persistedRows.length > 0) {
    // Batch-scoped dedupe only — a full-table sweep on every client mirror
    // was taking tens of seconds and blocking the whole portal load.
    await reconcileDuplicateChargeList(
      db,
      persistedRows.map((row) => row.row_data as HouseholdCharge),
      actor.role === "admin" ? undefined : actor.id,
      new Set(chargeIds),
    ).catch(() => undefined);
    // Reminders + ledger/GL sync run ONLY over rows that were actually
    // persisted (mappedRows) — NOT the full client list. A foreign charge a
    // read-only co-manager was forbidden to persist (skipped above) must not
    // reach syncLedgerChargeEntry, which would otherwise write owner-attributed
    // ledger/GL rows from the co-manager's untrusted mirror copy. The owner id
    // comes from the row's resolved manager_user_id, not the caller.
    for (const row of persistedRows) {
      const chargeId = row.id;
      const nextStatus = row.status;
      if (!nextStatus) continue;
      const managerId = row.manager_user_id ?? actor.id;
      const prevStatus = previousStatusById.get(chargeId) ?? null;
      const nextFingerprint = householdChargeLedgerFingerprint(row.row_data);
      const prevFingerprint = existingLedgerFingerprintById.get(chargeId);
      const isNewRow = !existingOwnerById.has(chargeId);
      if (!isNewRow && prevFingerprint === nextFingerprint) continue;
      if (nextStatus === "paid" && prevStatus !== "paid") {
        await cancelFuturePaymentRemindersForCharge(db, managerId, chargeId).catch(() => undefined);
      }
      // No paid→pending branch here: the paid-sticky guard skips those rows,
      // so a downgrade can only arrive via action:"unmarkPaid" (which restores
      // reminders itself). A stale mirror can no longer revert a paid charge.
      // Attribute the ledger/GL entry to the SERVER-resolved owner, not the
      // client-supplied row_data.managerUserId (which a caller controls).
      await syncLedgerChargeEntry(db, { ...(row.row_data as HouseholdCharge), managerUserId: managerId }).catch(
        () => undefined,
      );
      await emitHouseholdChargeTransition(db, {
        managerUserId: managerId,
        previousStatus: prevStatus,
        charge: { ...(row.row_data as HouseholdCharge), managerUserId: managerId },
        transitionId: `${chargeId}:${nextStatus}:${now}`,
      }).catch(() => undefined);
    }
  }
  return { persistedRows, chargeWriteError };
}
