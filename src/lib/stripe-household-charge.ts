import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseMoneyAmount } from "@/lib/parse-money";
import { residentConnectApplicationFeeCents, type ResidentAxisPaymentMethod } from "@/lib/payment-policy";
import type { HouseholdCharge } from "@/lib/household-charges";
import { cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
import { syncLedgerPaymentEntry } from "@/lib/reports/ledger-sync";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";

export const HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE = "household_charge";

/** @deprecated Use residentConnectApplicationFeeCents with explicit payment method. */
export function axisAchPlatformFeeCents(grossAmountCents: number): number {
  return residentConnectApplicationFeeCents(grossAmountCents, "ach");
}

export function axisConnectPlatformFeeCents(
  grossAmountCents: number,
  method: ResidentAxisPaymentMethod,
  managerTier?: string | null,
): number {
  return residentConnectApplicationFeeCents(grossAmountCents, method, managerTier);
}

export function householdChargeAmountCents(charge: Pick<HouseholdCharge, "balanceLabel" | "amountLabel">): number {
  const raw = charge.balanceLabel?.trim() || charge.amountLabel?.trim() || "";
  const dollars = parseMoneyAmount(raw);
  if (!(dollars > 0)) return 0;
  return Math.round(dollars * 100);
}

export function isHouseholdChargeCheckoutSession(session: Stripe.Checkout.Session): boolean {
  return session.metadata?.purpose === HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE;
}

export function householdChargeCheckoutPaid(session: Stripe.Checkout.Session): boolean {
  return session.payment_status === "paid" || session.payment_status === "no_payment_required";
}

export function householdChargeCheckoutProcessing(session: Stripe.Checkout.Session): boolean {
  return session.status === "complete" && session.payment_status === "unpaid";
}

function householdChargeIdsFromSession(session: Stripe.Checkout.Session): string[] {
  const chargeIds =
    session.metadata?.charge_ids
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  const fallbackId = session.metadata?.charge_id?.trim();
  return chargeIds.length > 0 ? chargeIds : fallbackId ? [fallbackId] : [];
}

/**
 * ACH submitted but not settled (Checkout complete, payment_status unpaid):
 * mark the charges `processing` so the clearing window can't double-charge,
 * fire late fees, or send payment reminders (all of those key on `pending`).
 * Resolved by async_payment_succeeded (→ paid) or async_payment_failed /
 * payment_intent.payment_failed (→ back to pending / failed + NSF).
 */
export async function markHouseholdChargeProcessingFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<{ ok: boolean; marked: number }> {
  if (!isHouseholdChargeCheckoutSession(session) || !householdChargeCheckoutProcessing(session)) {
    return { ok: false, marked: 0 };
  }
  const now = new Date().toISOString();
  let marked = 0;
  for (const chargeId of householdChargeIdsFromSession(session)) {
    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("id, row_data, status")
      .eq("id", chargeId)
      .maybeSingle();
    const charge = row?.row_data as HouseholdCharge | null;
    if (!charge?.id) continue;
    if (charge.status !== "pending" && charge.status !== "failed" && charge.status !== "partially_paid") continue;
    const nextCharge: HouseholdCharge = { ...charge, status: "processing" };
    const { error } = await db.from("portal_household_charge_records").upsert(
      {
        id: chargeId,
        manager_user_id: charge.managerUserId,
        resident_user_id: charge.residentUserId,
        resident_email: charge.residentEmail.trim().toLowerCase(),
        property_id: charge.propertyId,
        kind: charge.kind,
        status: "processing",
        row_data: {
          ...nextCharge,
          stripeCheckoutSessionId: session.id,
          stripePaymentStatus: session.payment_status,
        },
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (!error) {
      marked += 1;
      const managerUserId = charge.managerUserId?.trim() || session.metadata?.manager_user_id?.trim() || "";
      if (managerUserId) {
        await emitHouseholdChargeTransition(db, {
          managerUserId,
          previousStatus: charge.status,
          charge: nextCharge,
          transitionId: `${chargeId}:payment_processing:${session.id}`,
        }).catch(() => undefined);
      }
    }
  }
  return { ok: marked > 0, marked };
}

/**
 * The async bank debit failed (checkout.session.async_payment_failed): put
 * `processing` charges back to `pending` so they are payable/remindable again.
 * NSF fee + `failed` status are owned by the payment_intent.payment_failed
 * handler — this only clears the clearing-window hold, and it never downgrades
 * a charge that handler already marked failed (or that was paid).
 */
export async function revertHouseholdChargeProcessingFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<{ ok: boolean; reverted: number }> {
  if (!isHouseholdChargeCheckoutSession(session)) return { ok: false, reverted: 0 };
  const now = new Date().toISOString();
  let reverted = 0;
  for (const chargeId of householdChargeIdsFromSession(session)) {
    const { data: row } = await db
      .from("portal_household_charge_records")
      .select("id, row_data, status")
      .eq("id", chargeId)
      .maybeSingle();
    const charge = row?.row_data as HouseholdCharge | null;
    if (!charge?.id || charge.status !== "processing") continue;
    const nextCharge: HouseholdCharge = { ...charge, status: "pending" };
    const { error } = await db.from("portal_household_charge_records").upsert(
      {
        id: chargeId,
        manager_user_id: charge.managerUserId,
        resident_user_id: charge.residentUserId,
        resident_email: charge.residentEmail.trim().toLowerCase(),
        property_id: charge.propertyId,
        kind: charge.kind,
        status: "pending",
        row_data: {
          ...nextCharge,
          stripeCheckoutSessionId: session.id,
          stripePaymentStatus: "failed",
        },
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (!error) reverted += 1;
  }
  return { ok: reverted > 0, reverted };
}

/**
 * Marks a pending household charge paid after Stripe confirms funds (sync or async ACH).
 */
export async function markHouseholdChargePaidFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<{ ok: boolean; chargeId?: string; alreadyPaid?: boolean }> {
  if (!isHouseholdChargeCheckoutSession(session)) {
    return { ok: false };
  }

  const chargeIds =
    session.metadata?.charge_ids
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  const fallbackId = session.metadata?.charge_id?.trim();
  const idsToMark = chargeIds.length > 0 ? chargeIds : fallbackId ? [fallbackId] : [];
  if (idsToMark.length === 0) return { ok: false };

  if (!householdChargeCheckoutPaid(session)) {
    return { ok: false };
  }

  // The id list comes from session metadata we set only after validating that
  // the paying user owns every charge, so it is trusted. Keep a defensive
  // consistency check that each charge belongs to the manager this session paid
  // out to. Do NOT gate on resident email: a bulk session carries a single
  // customer_email, so a charge whose stored email drifted from it would be
  // silently left unmarked even though the resident already paid for it.
  const expectedManagerUserId = session.metadata?.manager_user_id?.trim() ?? "";

  let marked = 0;
  let alreadyPaid = false;
  const now = new Date().toISOString();

  for (const chargeId of idsToMark) {
    const { data: row, error } = await db
      .from("portal_household_charge_records")
      .select("id, row_data, status")
      .eq("id", chargeId)
      .maybeSingle();

    if (error || !row) continue;

    const charge = row.row_data as HouseholdCharge | null;
    if (!charge?.id) continue;

    if (row.status === "paid" || charge.status === "paid") {
      alreadyPaid = true;
      marked += 1;
      await syncLedgerPaymentEntry(db, charge, charge.paidAt, session.id).catch((err) => {
        console.error("[stripe-household-charge] ledger heal for already-paid charge failed", err);
      });
      continue;
    }

    const chargeManagerUserId = charge.managerUserId?.trim() ?? "";
    if (expectedManagerUserId && chargeManagerUserId && chargeManagerUserId !== expectedManagerUserId) {
      continue;
    }

    const nextCharge: HouseholdCharge = {
      ...charge,
      status: "paid",
      paidAt: now,
      balanceLabel: "$0.00",
    };

    const { error: upsertErr } = await db.from("portal_household_charge_records").upsert(
      {
        id: chargeId,
        manager_user_id: charge.managerUserId,
        resident_user_id: charge.residentUserId,
        resident_email: charge.residentEmail.trim().toLowerCase(),
        property_id: charge.propertyId,
        kind: charge.kind,
        status: "paid",
        row_data: {
          ...nextCharge,
          stripeCheckoutSessionId: session.id,
          stripePaymentStatus: session.payment_status,
        },
        updated_at: now,
      },
      { onConflict: "id" },
    );

    if (!upsertErr) {
      marked += 1;
      await syncLedgerPaymentEntry(db, nextCharge, now, session.id);
      const managerUserId = charge.managerUserId?.trim() || expectedManagerUserId;
      if (managerUserId) {
        await cancelFuturePaymentRemindersForCharge(db, managerUserId, chargeId).catch(() => undefined);
        await emitHouseholdChargeTransition(db, {
          managerUserId,
          previousStatus: charge.status,
          charge: nextCharge,
          transitionId: `${chargeId}:payment_received:${session.id}`,
        }).catch(() => undefined);
      }
    }
  }

  if (marked === 0) return { ok: false };
  return { ok: true, chargeId: idsToMark[0], alreadyPaid };
}
