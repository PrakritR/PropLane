import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { voidLedgerEntriesForCharge } from "@/lib/reports/ledger-sync";
import { cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";

export const VOID_REASON_MIN = 3;
export const VOID_REASON_MAX = 300;

export type VoidChargeResult =
  | { ok: true; charge: HouseholdCharge; alreadyVoid: boolean }
  | { ok: false; status: number; error: string };

/** A real card/bank payment sits behind the charge (Stripe session, not a hand-recorded receipt). */
export function chargeHasProviderPayment(charge: Pick<HouseholdCharge, "stripeCheckoutSessionId" | "paidMethod">): boolean {
  return Boolean(charge.stripeCheckoutSessionId?.trim() && !charge.paidMethod);
}

export const VOID_PROVIDER_PAYMENT_ERROR =
  "A real card or bank payment captured money for this charge. Void cannot return it: use Refund instead.";

/**
 * Did Stripe capture money for this charge? The charge's own session (without a hand-recorded method) says so, and so
 * does any ledger payment line that carries a Stripe session or charge id - a hand-marked receipt never has one.
 * Fails closed: an unreadable ledger counts as provider money.
 */
export async function chargeCapturedProviderMoney(db: SupabaseClient, charge: HouseholdCharge): Promise<boolean> {
  if (chargeHasProviderPayment(charge)) return true;
  const { data, error } = await db
    .from("ledger_entries")
    .select("stripe_checkout_session_id, stripe_charge_id")
    .eq("source_charge_id", charge.id)
    .eq("entry_type", "payment");
  if (error) return true;
  return ((data ?? []) as { stripe_checkout_session_id?: string | null; stripe_charge_id?: string | null }[]).some(
    (row) => Boolean(row.stripe_checkout_session_id?.trim() || row.stripe_charge_id?.trim()),
  );
}

/**
 * Void a PAID charge recorded in error (a duplicate, a wrong tenant, a hand-marked receipt). Owner only: the signed-in user must BE the row's `manager_user_id` (the workspace owner, or
 * the service owner on a managed workspace) - never a co-manager, a Property owner seat or a resident. Needs a
 * reason. Never deletes: the row stays with `status: "void"`, who/when/why, one `audit_log` row is written FIRST,
 * and the books get balanced reversing entries for the charge AND its hand-recorded receipt
 * (`voidLedgerEntriesForCharge`). It never moves money: a charge Stripe captured money for is refused (409) and goes
 * through Refund.
 *
 * Idempotent: voiding a void charge re-runs the ledger step (repairs a half-finished void) and reports ok.
 */
export async function voidPaidCharge(
  db: SupabaseClient,
  input: { chargeId: string; actorUserId: string; reason: unknown; now?: string },
): Promise<VoidChargeResult> {
  const id = input.chargeId.trim();
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!id) return { ok: false, status: 400, error: "id required" };
  if (reason.length < VOID_REASON_MIN || reason.length > VOID_REASON_MAX) {
    return { ok: false, status: 400, error: `Give a reason (${VOID_REASON_MIN}-${VOID_REASON_MAX} characters).` };
  }
  const now = input.now ?? new Date().toISOString();
  const { data: existing, error: readError } = await db
    .from("portal_household_charge_records")
    .select("manager_user_id, property_id, status, row_data, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (readError) return { ok: false, status: 500, error: "Could not read charge." };
  if (!existing) return { ok: false, status: 404, error: "Charge not found." };
  const ownerId = existing.manager_user_id ? String(existing.manager_user_id) : "";
  if (!ownerId || ownerId !== input.actorUserId) {
    return { ok: false, status: 403, error: "Only the workspace owner can void a paid charge." };
  }
  const current = { ...(existing.row_data as HouseholdCharge), id, managerUserId: ownerId };
  if (current.kind === "security_deposit") {
    return { ok: false, status: 409, error: "A security deposit is a liability: return it through Return deposit, not Void." };
  }
  if ((current.refundedCents ?? 0) > 0) {
    return { ok: false, status: 409, error: "This charge has a refund on it. Settle the refund first." };
  }

  if (existing.status === "void") {
    // Repair a half-finished void the way it was made: receipts are reversed only for a void that reversed them.
    await voidLedgerEntriesForCharge(db, current, current.voidedAt ?? now, { reverseReceipt: current.voidReceiptReversed === true });
    return { ok: true, charge: current, alreadyVoid: true };
  }
  if (existing.status !== "paid") {
    return { ok: false, status: 409, error: "Only a paid charge can be voided. Delete or edit an unpaid one." };
  }
  if (await chargeCapturedProviderMoney(db, current)) {
    return { ok: false, status: 409, error: VOID_PROVIDER_PAYMENT_ERROR };
  }

  // Audit first: if it cannot be written the charge does not move.
  const { error: auditError } = await db.from("audit_log").insert({
    actor_user_id: input.actorUserId,
    landlord_id: ownerId,
    action: "charge_voided",
    tool_name: "portal_household_charges",
    input_summary: { chargeId: id, kind: current.kind, amountLabel: current.amountLabel, reason },
    result_summary: { outcome: "voided", refunded: false, receiptReversed: true },
    dedupe_key: `charge-void:${id}`,
  });
  if (auditError && auditError.code !== "23505") {
    return { ok: false, status: 500, error: "Could not record the void. Nothing changed." };
  }

  const voided: HouseholdCharge = {
    ...current,
    status: "void",
    balanceLabel: "$0.00",
    voidedAt: now,
    voidedBy: input.actorUserId,
    voidReason: reason,
    voidReceiptReversed: true,
  };
  let update = db
    .from("portal_household_charge_records")
    .update({ status: "void", row_data: voided, updated_at: now })
    .eq("id", id)
    .eq("status", "paid");
  update = existing.updated_at == null ? update.is("updated_at", null) : update.eq("updated_at", existing.updated_at);
  const { data: saved, error: saveError } = await update.select("id").maybeSingle();
  if (saveError) return { ok: false, status: 500, error: "Could not void the charge." };
  if (!saved) return { ok: false, status: 409, error: "Charge changed. Refresh and try again." };

  await voidLedgerEntriesForCharge(db, voided, now, { reverseReceipt: true });
  await cancelFuturePaymentRemindersForCharge(db, ownerId, id).catch(() => undefined);
  return { ok: true, charge: voided, alreadyVoid: false };
}
