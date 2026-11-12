import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { persistHouseholdChargeRows, type HouseholdChargeWriteRow } from "@/lib/household-charge-persist.server";
import { decideChargeRefund } from "@/lib/charge-refund";
import { resolveChargePaidCents } from "@/lib/charge-paid-cents.server";
import { runHouseholdChargeRefund } from "@/lib/household-charge-refund-coordinator.server";
import { loadManagerTourSettings, normalizeManagerTourSettings } from "@/lib/manager-tour-settings";
import { resolveSettingsScope } from "@/lib/settings/scope-resolver.server";
import { resolvePropertyOwnerUserId } from "@/lib/property-owner.server";
import { normalizeTourFeeCents, tourFeeAmountLabel, tourFeeChargeId } from "@/lib/tour-fee";

/**
 * The optional tour fee on the server (see `tour-fee.ts`). Three moments, one charge:
 *
 *   booking   `raiseTourFeeCharge`  a signed-in guest's request raises ONE pending `tour_fee` charge when the fee is above 0,
 *                                   through `persistHouseholdChargeRows` (the one charge write path: ledger sync, then the
 *                                   `charge_created` notice with its pay link). The pending request is the slot's hold.
 *   confirm   `tourFeeConfirmGate`  a request with an unpaid fee cannot be confirmed; a paid one (or none) is unaffected.
 *   cancel    `settleTourFeeOnCancel`  a paid fee is refunded through the durable refund coordinator; an unpaid one is cancelled.
 *
 * A fee of 0 changes nothing anywhere: no charge, no gate, no refund.
 */

/** The fee for a house's tours, in cents; 0 on any doubt (an unreadable setting must not stop a guest booking). */
export async function resolveTourFeeCents(
  db: SupabaseClient,
  input: { managerUserId: string; propertyId: string | null },
): Promise<number> {
  try {
    const { value } = await resolveSettingsScope(
      db,
      { managerUserId: input.managerUserId, propertyId: input.propertyId, workspaceId: null },
      "tourSettings",
      { normalize: normalizeManagerTourSettings, loadAccount: (d, m) => loadManagerTourSettings(d, m) },
    );
    return normalizeTourFeeCents(value.tourFeeCents);
  } catch {
    return 0;
  }
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TourFeeInfo = { chargeId: string; amountCents: number; amountLabel: string };

/**
 * Raise the fee charge for a freshly filed tour request. Only a signed-in guest (`residentUserId`: the verified session) owes
 * one: an SMS prospect has no account to pay from, so nothing is raised for them. Idempotent on the inquiry (the charge id is
 * derived from it). Returns null when there is no fee (0, or no account) and throws when the fee is owed but could not be
 * written, so the caller can refuse the request instead of leaving a tour that skipped its fee.
 */
export async function raiseTourFeeCharge(
  db: SupabaseClient,
  input: {
    inquiry: Row;
    inquiryId: string;
    residentUserId: string | null;
    residentEmail: string | null;
    /** The host the request was filed under; the fee is set (and billed) on the house's owner, resolved here. */
    hostUserId: string;
    now?: Date;
  },
): Promise<TourFeeInfo | null> {
  const residentUserId = input.residentUserId?.trim() ?? "";
  const email = (input.residentEmail ?? "").trim().toLowerCase();
  if (!residentUserId || !email) return null;
  const propertyId = str(input.inquiry.propertyId) || null;
  const ownerId = (await resolvePropertyOwnerUserId(db, propertyId)) ?? input.hostUserId;
  if (!ownerId) return null;
  const amountCents = await resolveTourFeeCents(db, { managerUserId: ownerId, propertyId });
  if (amountCents <= 0) return null;

  const stamp = (input.now ?? new Date()).toISOString();
  const chargeId = tourFeeChargeId(input.inquiryId);
  const label = tourFeeAmountLabel(amountCents);
  const charge: HouseholdCharge = {
    id: chargeId,
    createdAt: stamp,
    tourInquiryId: input.inquiryId,
    residentEmail: email,
    residentName: str(input.inquiry.name) || "Guest",
    residentUserId,
    propertyId: propertyId ?? "",
    propertyLabel: str(input.inquiry.propertyTitle),
    managerUserId: ownerId,
    kind: "tour_fee",
    title: "Tour fee",
    amountLabel: label,
    balanceLabel: label,
    status: "pending",
    blocksLeaseUntilPaid: false,
  };
  const row: HouseholdChargeWriteRow = {
    id: chargeId,
    manager_user_id: ownerId,
    resident_user_id: UUID.test(residentUserId) ? residentUserId : null,
    resident_email: email,
    property_id: propertyId,
    kind: "tour_fee",
    status: "pending",
    row_data: charge as unknown as Record<string, unknown>,
    updated_at: stamp,
  };
  const { persistedRows, confirmedIds, chargeWriteError } = await persistHouseholdChargeRows(db, [row], {
    actor: { id: ownerId, role: "manager" },
    now: stamp,
    chargeIds: [chargeId],
    previousStatusById: new Map(),
    existingOwnerById: new Map(),
    existingUpdatedAtById: new Map(),
    existingRecordById: new Map(),
    existingLedgerFingerprintById: new Map(),
  });
  // A 23505 (the same inquiry replayed) lands in neither list and is not an error: the row already exists.
  if (chargeWriteError && persistedRows.length === 0 && confirmedIds.length === 0) throw new Error(chargeWriteError);
  return { chargeId, amountCents, amountLabel: label };
}

export type TourFeeStatus = { kind: "none" } | { kind: "unpaid"; chargeId: string } | { kind: "paid"; chargeId: string };

/** The fee state of a tour request, read from the stored charge (never from the request). `none` = no fee was raised. */
export async function tourFeeStatus(db: SupabaseClient, inquiryId: string): Promise<TourFeeStatus> {
  const chargeId = tourFeeChargeId(inquiryId);
  const { data, error } = await db.from("portal_household_charge_records").select("status").eq("id", chargeId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { kind: "none" };
  const status = str((data as Row).status);
  if (status === "paid" || status === "refunded") return { kind: "paid", chargeId };
  // A cancelled charge (the tour was declined or cancelled) owes nothing and blocks nothing.
  if (status === "cancelled") return { kind: "none" };
  return { kind: "unpaid", chargeId };
}

export const TOUR_FEE_UNPAID_MESSAGE = "The tour fee has not been paid yet. A tour is confirmed after the guest pays it.";

/** Null when the request may be confirmed; otherwise the refusal. A failed read refuses (never confirms a tour that may owe a fee). */
export async function tourFeeConfirmGate(
  db: SupabaseClient,
  inquiryId: string,
): Promise<{ status: 402 | 503; error: string } | null> {
  try {
    const fee = await tourFeeStatus(db, inquiryId);
    return fee.kind === "unpaid" ? { status: 402, error: TOUR_FEE_UNPAID_MESSAGE } : null;
  } catch {
    return { status: 503, error: "Could not verify the tour fee. Try again." };
  }
}

export type TourFeeSettlement =
  | { outcome: "no_fee" }
  | { outcome: "cancelled"; chargeId: string }
  | { outcome: "refund_pending"; chargeId: string }
  | { outcome: "needs_review"; chargeId: string; message: string };

/**
 * The manager cancelled (or declined) the tour: a PAID fee goes back to the guest through the durable refund coordinator
 * (its attempt id is the provider's idempotency key, and the ledger is booked by the refund webhook); an unpaid fee is
 * cancelled so it can no longer be paid. Idempotent per inquiry: the operation key is derived from it, so a retried cancel
 * resumes the same reservation. Never throws; a refusal is `needs_review` so the manager can refund from Payments.
 */
export async function settleTourFeeOnCancel(
  db: SupabaseClient,
  input: { inquiryId: string; reason: string; stripe?: import("stripe").default },
): Promise<TourFeeSettlement> {
  const chargeId = tourFeeChargeId(input.inquiryId);
  try {
    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("id, manager_user_id, status, row_data")
      .eq("id", chargeId)
      .maybeSingle();
    if (!row) return { outcome: "no_fee" };
    const status = str((row as Row).status);
    const charge = (((row as Row).row_data ?? {}) as Row);
    if (status === "cancelled") return { outcome: "no_fee" };

    if (status !== "paid" && status !== "refunded") {
      if (status === "processing") {
        // A bank payment still clearing cannot be refunded yet and must not be cancelled out from under the guest.
        return { outcome: "needs_review", chargeId, message: "The tour fee payment is still clearing. Refund it from Payments once it has." };
      }
      const nowIso = new Date().toISOString();
      const { error } = await db
        .from("portal_household_charge_records")
        .update({ status: "cancelled", row_data: { ...charge, status: "cancelled", balanceLabel: "$0.00" }, updated_at: nowIso })
        .eq("id", chargeId)
        .eq("status", status);
      if (error) return { outcome: "needs_review", chargeId, message: error.message };
      return { outcome: "cancelled", chargeId };
    }

    const { data: payment, error: paymentError } = await db
      .from("ledger_entries")
      .select("stripe_charge_id, amount_cents")
      .eq("source_charge_id", chargeId)
      .eq("entry_type", "payment")
      .maybeSingle();
    if (paymentError) return { outcome: "needs_review", chargeId, message: "Could not verify the payment ledger." };
    const paidCents = resolveChargePaidCents((payment as Row | null)?.amount_cents as number | null | undefined, charge);
    const decision = decideChargeRefund({
      kind: "tour_fee",
      status: "paid",
      paidCents,
      alreadyRefundedCents: Number(charge.refundedCents ?? 0),
      stripeChargeId: ((payment as Row | null)?.stripe_charge_id as string | null) ?? null,
      settled: charge.stripePaymentStatus !== "processing" && charge.stripePaymentStatus !== "pending",
    });
    if (!decision.ok) {
      // Already refunded in full is the settled state; anything else needs a person.
      return decision.reason === "nothing_left"
        ? { outcome: "refund_pending", chargeId }
        : { outcome: "needs_review", chargeId, message: decision.message };
    }
    let stripe = input.stripe;
    if (!stripe) {
      const { getStripe } = await import("@/lib/stripe");
      stripe = getStripe();
    }
    const outcome = await runHouseholdChargeRefund(stripe, db, {
      ownerUserId: str((row as Row).manager_user_id),
      chargeId,
      stripeChargeId: decision.stripeChargeId,
      paymentIntentId: null,
      amountCents: decision.amountCents,
      operationKey: `tour-fee-refund:${input.inquiryId}`,
      basis: {
        kind: "tour_fee_refund",
        inquiryId: input.inquiryId,
        reason: input.reason,
        paidCents,
        baselineRefundedCents: Number(charge.refundedCents ?? 0),
        stripeChargeId: decision.stripeChargeId,
      },
      metadata: { proplane_charge_id: chargeId, kind: "tour_fee_refund", reason: input.reason },
    });
    if (outcome.kind === "pending") return { outcome: "refund_pending", chargeId };
    return { outcome: "needs_review", chargeId, message: outcome.kind === "review" ? outcome.message : outcome.message };
  } catch (error) {
    return { outcome: "needs_review", chargeId, message: error instanceof Error ? error.message : "Could not refund the tour fee." };
  }
}
