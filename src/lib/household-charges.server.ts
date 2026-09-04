/**
 * Server-side charge-upsert core, extracted from the POST handler of
 * /api/portal-household-charges so the route and the agent tool layer share ONE
 * implementation (AGENTS.md: same function backs the UI and the agent).
 *
 * Behavior preserved exactly from the route:
 *  - due-date normalization for reminder projection (ensureChargeDueDateForReminders),
 *  - previous-status lookup so paid/pending transitions cancel/restore reminders,
 *  - row mapping with the manager scope pinned to the caller (admin saves may
 *    honor the row's own managerUserId via opts),
 *  - upsert onConflict id + duplicate-charge reconciliation,
 *  - write-through ledger sync per charge (AGENTS.md hard rule — every charge
 *    mutation path MUST call syncLedgerChargeEntry next to the DB write).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import {
  cancelFuturePaymentRemindersForCharge,
  restoreFuturePaymentRemindersForCharge,
} from "@/lib/payment-reminder-lifecycle.server";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  loadManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { ensureChargeDueDateForReminders } from "@/lib/payment-reminder-bootstrap";
import { reconcileDuplicateHouseholdChargeRecords, syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";

function toUuid(id: unknown): string | null {
  if (!id || typeof id !== "string") return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  return null;
}

export type UpsertManagerChargesOptions = {
  /**
   * Admin-console saves may carry rows owned by other managers; when true each
   * row's own managerUserId (if a valid uuid) wins over the caller id and the
   * duplicate reconciliation runs unscoped. Never set from tool code — tools
   * always pin every row to the authenticated landlord.
   */
  trustRowManagerUserId?: boolean;
};

/**
 * Upsert household charge rows for a manager. `managerUserId` MUST come from
 * the authenticated context (route session / AgentContext), never from client
 * or model input. Throws on upsert failure so callers surface the error.
 */
export async function upsertManagerCharges(
  db: SupabaseClient,
  managerUserId: string,
  charges: Record<string, unknown>[],
  opts: UpsertManagerChargesOptions = {},
): Promise<void> {
  if (charges.length === 0) return;
  const now = new Date().toISOString();

  const reminderSettings = await loadManagerAutomationSettings(db, managerUserId).catch(
    () => DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  );
  const normalizedCharges = charges.map((raw) => {
    if (!raw.id || raw.status === "paid") return raw;
    const charge = raw as HouseholdCharge;
    const prepared = ensureChargeDueDateForReminders(charge, reminderSettings);
    if (prepared.dueDateLabel === charge.dueDateLabel) return raw;
    return { ...raw, dueDateLabel: prepared.dueDateLabel };
  });

  const chargeIds = normalizedCharges.filter((c) => c.id).map((c) => String(c.id));
  const previousStatusById = new Map<string, string | null>();
  if (chargeIds.length > 0) {
    const { data: existingRows } = await db
      .from("portal_household_charge_records")
      .select("id, status")
      .in("id", chargeIds);
    for (const row of existingRows ?? []) {
      previousStatusById.set(String(row.id), typeof row.status === "string" ? row.status : null);
    }
  }

  const resolveManagerId = (c: Record<string, unknown>) =>
    opts.trustRowManagerUserId ? toUuid(c.managerUserId) ?? managerUserId : managerUserId;

  const rows = normalizedCharges
    .filter((c) => c.id)
    .map((c) => ({
      id: String(c.id),
      manager_user_id: resolveManagerId(c),
      resident_user_id: toUuid(c.residentUserId),
      resident_email: typeof c.residentEmail === "string" ? c.residentEmail.trim().toLowerCase() : null,
      property_id: typeof c.propertyId === "string" ? c.propertyId : null,
      kind: typeof c.kind === "string" ? c.kind : null,
      status: typeof c.status === "string" ? c.status : null,
      row_data: c,
      updated_at: now,
    }));
  if (rows.length === 0) return;

  const { error } = await db.from("portal_household_charge_records").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(error.message);
  await reconcileDuplicateHouseholdChargeRecords(
    db,
    opts.trustRowManagerUserId ? undefined : managerUserId,
  ).catch(() => undefined);

  for (const c of normalizedCharges) {
    if (!c.id) continue;
    const chargeId = String(c.id);
    const nextStatus = typeof c.status === "string" ? c.status : null;
    if (!nextStatus) continue;
    const managerId = resolveManagerId(c);
    const prevStatus = previousStatusById.get(chargeId) ?? null;
    if (nextStatus === "paid" && prevStatus !== "paid") {
      await cancelFuturePaymentRemindersForCharge(db, managerId, chargeId).catch(() => undefined);
    } else if (nextStatus === "pending" && prevStatus === "paid") {
      await restoreFuturePaymentRemindersForCharge(db, managerId, chargeId).catch(() => undefined);
    }
    await syncLedgerChargeEntry(db, c as HouseholdCharge);
    await emitHouseholdChargeTransition(db, {
      managerUserId: managerId,
      previousStatus: prevStatus,
      charge: { ...(c as HouseholdCharge), managerUserId: managerId },
      transitionId: `${chargeId}:${nextStatus}:${now}`,
    }).catch(() => undefined);
  }
}
