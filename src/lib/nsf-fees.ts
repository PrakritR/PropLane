import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { loadManagerBillingSettings } from "@/lib/manager-billing-settings";
import { syncLedgerChargeEntry } from "@/lib/reports/ledger-sync";
import { track } from "@/lib/analytics/posthog";

/** Deterministic NSF-fee charge id for one failed charge — shared with the caller so it can
 *  read-before-write and skip a duplicate fee for a redelivered failure webhook. */
export function nsfFeeIdForCharge(chargeId: string): string {
  return `hc_nsf_${chargeId}`;
}

export async function createNsfFeeForFailedPayment(
  db: SupabaseClient,
  failedCharge: HouseholdCharge,
  managerUserId: string,
): Promise<string | null> {
  const settings = await loadManagerBillingSettings(db, managerUserId);
  if (!settings.nsfFeeEnabled || settings.nsfFeeAmountCents <= 0) return null;

  // Deterministic, per-failed-charge id (no `Date.now()`) so a redelivered
  // `payment_intent.payment_failed` webhook for the same failed charge can never
  // mint a second NSF fee — the caller reads this id before writing to skip the
  // duplicate outright, and even a race lands on the same `onConflict: "id"` row.
  const id = nsfFeeIdForCharge(failedCharge.id);
  const now = new Date().toISOString();
  const amountLabel = `$${(settings.nsfFeeAmountCents / 100).toFixed(2)}`;

  const nsfCharge: HouseholdCharge = {
    ...failedCharge,
    id,
    kind: "nsf_fee",
    title: `NSF fee — ${failedCharge.title}`,
    amountLabel,
    balanceLabel: amountLabel,
    status: "pending",
    createdAt: now,
    paidAt: undefined,
  };

  await db.from("portal_household_charge_records").upsert(
    {
      id,
      manager_user_id: managerUserId,
      resident_email: failedCharge.residentEmail.trim().toLowerCase(),
      status: "pending",
      row_data: nsfCharge,
      updated_at: now,
    },
    { onConflict: "id" },
  );

  await syncLedgerChargeEntry(db, nsfCharge);
  track("nsf_fee_charged", managerUserId, { sourceChargeId: failedCharge.id, amountCents: settings.nsfFeeAmountCents });
  return id;
}

export function applyPartialPaymentCents(totalCents: number, paidCents: number): {
  status: "pending" | "partially_paid" | "paid";
  paidAmountCents: number;
  balanceCents: number;
} {
  const paid = Math.max(0, Math.min(totalCents, Math.round(paidCents)));
  const balance = totalCents - paid;
  let status: "pending" | "partially_paid" | "paid" = "pending";
  if (paid >= totalCents && totalCents > 0) status = "paid";
  else if (paid > 0) status = "partially_paid";
  return { status, paidAmountCents: paid, balanceCents: balance };
}
