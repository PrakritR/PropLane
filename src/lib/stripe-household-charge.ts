import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseMoneyAmount } from "@/lib/parse-money";
import { residentConnectApplicationFeeCents, type ResidentAxisPaymentMethod } from "@/lib/payment-policy";
import type { HouseholdCharge } from "@/lib/household-charges";
import { cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
import { syncLedgerPaymentEntry } from "@/lib/reports/ledger-sync";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";
import { enqueueWebhookEvent } from "@/lib/webhooks/deliver.server";
import { webhookEventBuilders } from "@/lib/webhooks/events";

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
 * Marks ONE pending household charge paid — the core both
 * `markHouseholdChargePaidFromStripeSession` (a Checkout Session, one or many
 * charges) and `markHouseholdChargePaidFromPaymentIntent` (a raw off-session
 * PaymentIntent, autopay's one charge) share, so a paid charge always gets the
 * exact same ledger write, reminder cancellation, transition event and
 * outbound webhook regardless of which Stripe object confirmed it.
 *
 * `stripeReference` is stored as `stripeCheckoutSessionId` on the charge row
 * for back-compat with every reader of that field — it holds a Checkout
 * Session id for a manual payment and a PaymentIntent id for an autopay run,
 * and either is a stable link back to what actually settled the payment.
 */
async function markOneHouseholdChargePaid(
  db: SupabaseClient,
  chargeId: string,
  opts: {
    expectedManagerUserId?: string;
    stripeReference: string;
    stripePaymentStatus: string;
    /** Distinguishes the transition id between session- and PI-driven marks for the same charge. */
    transitionSuffix: string;
  },
): Promise<{ marked: boolean; alreadyPaid: boolean; charge?: HouseholdCharge }> {
  const { data: row, error } = await db
    .from("portal_household_charge_records")
    .select("id, row_data, status")
    .eq("id", chargeId)
    .maybeSingle();
  if (error || !row) return { marked: false, alreadyPaid: false };

  const charge = row.row_data as HouseholdCharge | null;
  if (!charge?.id) return { marked: false, alreadyPaid: false };

  const now = new Date().toISOString();

  if (row.status === "paid" || charge.status === "paid") {
    await syncLedgerPaymentEntry(db, charge, charge.paidAt, opts.stripeReference).catch((err) => {
      console.error("[stripe-household-charge] ledger heal for already-paid charge failed", err);
    });
    return { marked: true, alreadyPaid: true, charge };
  }

  const chargeManagerUserId = charge.managerUserId?.trim() ?? "";
  if (opts.expectedManagerUserId && chargeManagerUserId && chargeManagerUserId !== opts.expectedManagerUserId) {
    return { marked: false, alreadyPaid: false };
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
        stripeCheckoutSessionId: opts.stripeReference,
        stripePaymentStatus: opts.stripePaymentStatus,
      },
      updated_at: now,
    },
    { onConflict: "id" },
  );
  if (upsertErr) return { marked: false, alreadyPaid: false };

  await syncLedgerPaymentEntry(db, nextCharge, now, opts.stripeReference);
  const managerUserId = charge.managerUserId?.trim() || opts.expectedManagerUserId || "";
  if (managerUserId) {
    await cancelFuturePaymentRemindersForCharge(db, managerUserId, chargeId).catch(() => undefined);
    await emitHouseholdChargeTransition(db, {
      managerUserId,
      previousStatus: charge.status,
      charge: nextCharge,
      transitionId: `${chargeId}:payment_received:${opts.transitionSuffix}`,
    }).catch(() => undefined);
    // Outbound webhooks: ids, amount and status only, and never throws here.
    await enqueueWebhookEvent(
      managerUserId,
      "payment.succeeded",
      webhookEventBuilders["payment.succeeded"]({
        chargeId,
        propertyId: nextCharge.propertyId,
        amountCents: Math.round(parseMoneyAmount(nextCharge.amountLabel) * 100),
        kind: nextCharge.kind,
      }),
    );
  }
  return { marked: true, alreadyPaid: false, charge: nextCharge };
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

  for (const chargeId of idsToMark) {
    const result = await markOneHouseholdChargePaid(db, chargeId, {
      expectedManagerUserId,
      stripeReference: session.id,
      stripePaymentStatus: session.payment_status,
      transitionSuffix: session.id,
    });
    if (result.marked) {
      marked += 1;
      if (result.alreadyPaid) alreadyPaid = true;
    }
  }

  if (marked === 0) return { ok: false };
  return { ok: true, chargeId: idsToMark[0], alreadyPaid };
}

/**
 * Marks the ONE charge an autopay off-session PaymentIntent paid, on
 * `payment_intent.succeeded`. Reuses the exact same per-charge core as a
 * manual Checkout payment — same ledger write-through, reminder cancellation,
 * transition event and outbound webhook — so an autopay success is
 * indistinguishable from a manual one everywhere downstream except the
 * `resident_autopay_runs` row (updated separately by the caller).
 */
export async function markHouseholdChargePaidFromPaymentIntent(
  db: SupabaseClient,
  paymentIntent: Stripe.PaymentIntent,
  chargeId: string,
): Promise<{ ok: boolean; alreadyPaid?: boolean }> {
  if (paymentIntent.status !== "succeeded") return { ok: false };
  const expectedManagerUserId = paymentIntent.metadata?.manager_user_id?.trim() || undefined;
  const result = await markOneHouseholdChargePaid(db, chargeId, {
    expectedManagerUserId,
    stripeReference: paymentIntent.id,
    stripePaymentStatus: paymentIntent.status,
    transitionSuffix: paymentIntent.id,
  });
  if (!result.marked) return { ok: false };
  return { ok: true, alreadyPaid: result.alreadyPaid };
}
