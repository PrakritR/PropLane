import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseMoneyAmount } from "@/lib/parse-money";
import { residentConnectApplicationFeeCents, type ResidentAxisPaymentMethod } from "@/lib/payment-policy";
import type { HouseholdCharge } from "@/lib/household-charges";
import { finalizeShortStayAfterPayment } from "@/lib/short-stay-booking.server";
import { cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
import { syncLedgerPaymentEntry } from "@/lib/reports/ledger-sync";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";
import { enqueueWebhookEvent } from "@/lib/webhooks/deliver.server";
import { webhookEventBuilders } from "@/lib/webhooks/events";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";
import { getStripe } from "@/lib/stripe";
import { loadResidentCheckoutAttemptForSession,
  loadResidentManualAchAttemptForPaymentIntent,
  type ResidentCheckoutAttempt } from "@/lib/resident-checkout-claim.server";
import { assertFreshHouseholdCapturedSource } from "@/lib/household-captured-source.server";

async function householdChargeProviderRefused(db: SupabaseClient, managerUserId: string, operation: string) {
  return (await captureTestWorkspaceEffectForUser({
    userId: managerUserId,
    kind: "payment",
    summary: "Household payment webhook mutation was refused for a test workspace.",
    metadata: { operation },
    db,
  })).captured;
}

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
  if (session.metadata?.source_arbitration_v === "1") {
    const attempt = await loadResidentCheckoutAttemptForSession(db, session);
    if (attempt.status === "settled") return { ok: false, marked: 0 };
    const { data: marked, error } = await db.rpc("mark_resident_checkout_processing", {
      p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
      p_session_id: session.id,
    });
    if (error) throw new Error(error.message);
    return { ok: true, marked: Number(marked ?? 0) };
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
    const managerUserId = charge.managerUserId?.trim() ?? "";
    if (!managerUserId || await householdChargeProviderRefused(db, managerUserId, "charge_processing")) continue;
    if (charge.status !== "pending" && charge.status !== "failed" && charge.status !== "partially_paid") continue;
    const nextCharge: HouseholdCharge = {
      ...charge,
      status: "processing",
      processingStartedAt: charge.processingStartedAt ?? now,
    };
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
          processingStartedAt: nextCharge.processingStartedAt,
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
  if (session.metadata?.source_arbitration_v === "1") {
    const attempt = await loadResidentCheckoutAttemptForSession(db, session);
    const { data: retired, error } = await db.rpc("retire_resident_checkout_attempt", {
      p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
      p_session_id: session.id, p_terminal_status: "failed",
    });
    if (error) throw new Error(error.message);
    return { ok: retired === true, reverted: retired === true ? attempt.charge_ids.length : 0 };
  }
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
    const managerUserId = charge.managerUserId?.trim() ?? "";
    if (!managerUserId || await householdChargeProviderRefused(db, managerUserId, "charge_processing_revert")) continue;
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
    paidAmountCents?: number;
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

  const durableManagerUserId = charge.managerUserId?.trim() ?? "";
  if (durableManagerUserId && await householdChargeProviderRefused(db, durableManagerUserId, "charge_paid")) {
    return { marked: false, alreadyPaid: false };
  }

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

  const faceCents = householdChargeAmountCents(charge);
  const paidAmountCents =
    opts.paidAmountCents && opts.paidAmountCents > 0 ? opts.paidAmountCents : faceCents > 0 ? faceCents : undefined;

  const nextCharge: HouseholdCharge = {
    ...charge,
    status: "paid",
    paidAt: now,
    balanceLabel: "$0.00",
    ...(paidAmountCents ? { paidAmountCents } : {}),
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

  await completeHouseholdChargePaid(db, nextCharge, charge.status, opts.stripeReference,
    opts.transitionSuffix, true);
  return { marked: true, alreadyPaid: false, charge: nextCharge };
}

async function completeHouseholdChargePaid(
  db: SupabaseClient, nextCharge: HouseholdCharge, previousStatus: HouseholdCharge["status"],
  stripeReference: string, transitionSuffix: string, newlySettled: boolean,
): Promise<void> {
  const chargeId = nextCharge.id;
  const now = nextCharge.paidAt;
  const rowData = nextCharge as HouseholdCharge & { shortStayBookingId?: string; agreementSha256?: string };
  if (!newlySettled) {
    await syncLedgerPaymentEntry(db, nextCharge, now, stripeReference);
    return;
  }
  if (rowData.shortStayBookingId) {
    await finalizeShortStayAfterPayment(db, rowData).catch((err) => {
      console.error("[stripe-household-charge] short-stay finalize failed", err);
    });
  }

  await syncLedgerPaymentEntry(db, nextCharge, now, stripeReference);
  const managerUserId = nextCharge.managerUserId?.trim() || "";
  if (managerUserId) {
    await cancelFuturePaymentRemindersForCharge(db, managerUserId, chargeId).catch(() => undefined);
    await emitHouseholdChargeTransition(db, {
      managerUserId,
      previousStatus,
      charge: nextCharge,
      transitionId: `${chargeId}:payment_received:${transitionSuffix}`,
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
}

async function settleClaimedHouseholdCart(
  db: SupabaseClient, attempt: ResidentCheckoutAttempt,
  sourceId: string, paymentIntent: Stripe.PaymentIntent,
  session?: Stripe.Checkout.Session,
): Promise<{ ok: boolean; chargeId?: string; alreadyPaid?: boolean }> {
  if (attempt.status !== "settled") {
    await assertFreshHouseholdCapturedSource(getStripe(),
      session ? { checkoutSession: session, paymentIntent } : { paymentIntent });
  }
  if (await householdChargeProviderRefused(db, attempt.manager_user_id, "charge_paid")) return { ok: false };
  const { data: settled, error: settleError } = await db.rpc("settle_resident_checkout_attempt", {
    p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
    p_session_id: sourceId, p_payment_intent_id: paymentIntent.id,
  });
  const paidRows = (settled as { rows?: unknown[]; newlySettled?: boolean } | null)?.rows;
  const newlySettled = (settled as { newlySettled?: boolean } | null)?.newlySettled === true;
  if (settleError || !Array.isArray(paidRows) || paidRows.length !== attempt.charge_ids.length) {
    throw new Error(settleError?.message || "Resident payment cart could not settle atomically.");
  }
  for (const [index, raw] of paidRows.entries()) {
    const charge = raw as HouseholdCharge;
    await syncLedgerPaymentEntry(db, charge, charge.paidAt, sourceId, attempt.charge_cents[index]);
    if (!newlySettled) continue;
    const rowData = charge as HouseholdCharge & { shortStayBookingId?: string };
    if (rowData.shortStayBookingId) await finalizeShortStayAfterPayment(db, rowData);
    await cancelFuturePaymentRemindersForCharge(db, attempt.manager_user_id, charge.id).catch(() => undefined);
    await emitHouseholdChargeTransition(db, {
      managerUserId: attempt.manager_user_id, previousStatus: "pending", charge,
      transitionId: `${charge.id}:payment_received:${sourceId}`,
    }).catch(() => undefined);
    await enqueueWebhookEvent(attempt.manager_user_id, "payment.succeeded",
      webhookEventBuilders["payment.succeeded"]({
        chargeId: charge.id, propertyId: charge.propertyId,
        amountCents: charge.paidAmountCents ?? 0, kind: charge.kind,
      }));
  }
  return { ok: true, chargeId: attempt.charge_ids[0], alreadyPaid: !newlySettled };
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
  if (session.metadata?.source_arbitration_v === "1") {
    const attempt = await loadResidentCheckoutAttemptForSession(db, session);
    if (session.status !== "complete" || session.payment_status !== "paid" ||
        !session.payment_intent || attempt.payer_total_cents <= 0) return { ok: false };
    const paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent : session.payment_intent.id;
    if (!paymentIntentId) return { ok: false };
    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== "succeeded" || paymentIntent.currency !== "usd" ||
        paymentIntent.amount_received !== attempt.payer_total_cents ||
        paymentIntent.metadata?.source_arbitration_v !== "1" ||
        paymentIntent.metadata?.resident_attempt_token !== attempt.attempt_token ||
        paymentIntent.metadata?.charge_ids !== attempt.charge_ids.join(",") ||
        paymentIntent.metadata?.manager_user_id !== attempt.manager_user_id ||
        paymentIntent.transfer_data?.destination || paymentIntent.application_fee_amount) {
      throw new Error("Captured PaymentIntent differs from the resident checkout attempt.");
    }
    return settleClaimedHouseholdCart(db, attempt, session.id, paymentIntent, session);
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

  const sessionPaidCents = typeof session.amount_total === "number" && session.amount_total > 0 ? session.amount_total : undefined;
  const perChargePaidCents =
    sessionPaidCents && idsToMark.length === 1 ? sessionPaidCents : undefined;

  for (const chargeId of idsToMark) {
    const result = await markOneHouseholdChargePaid(db, chargeId, {
      expectedManagerUserId,
      stripeReference: session.id,
      stripePaymentStatus: session.payment_status,
      transitionSuffix: session.id,
      paidAmountCents: perChargePaidCents,
    });
    if (result.marked) {
      marked += 1;
      if (result.alreadyPaid) alreadyPaid = true;
    }
  }

  if (marked === 0) return { ok: false };
  return { ok: true, chargeId: idsToMark[0], alreadyPaid };
}

/** Manual ACH PI counterpart to the Checkout Session helpers. A mandate and
 * microdeposit step can be pending for days; only succeeded funds settle. */
export async function reconcileResidentManualAchPaymentIntent(
  db: SupabaseClient, paymentIntent: Stripe.PaymentIntent,
  expectedResidentUserId?: string,
): Promise<{ ok: boolean; paid: boolean; processing: boolean; chargeId?: string; alreadyPaid?: boolean }> {
  const attempt = await loadResidentManualAchAttemptForPaymentIntent(
    db, paymentIntent, expectedResidentUserId);
  if (paymentIntent.status === "succeeded") {
    const settled = await settleClaimedHouseholdCart(db, attempt, paymentIntent.id, paymentIntent);
    return { ...settled, paid: settled.ok, processing: false };
  }
  const awaitingMicrodeposits = paymentIntent.status === "requires_action" &&
    paymentIntent.next_action?.type === "verify_with_microdeposits";
  if (awaitingMicrodeposits || paymentIntent.status === "processing") {
    const { data: marked, error } = await db.rpc("mark_resident_checkout_processing", {
      p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token,
      p_session_id: paymentIntent.id,
    });
    if (error || typeof marked !== "number") {
      return { ok: false, paid: false, processing: false };
    }
    return { ok: true, paid: false, processing: true, chargeId: attempt.charge_ids[0] };
  }
  return { ok: false, paid: false, processing: false };
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
  if (paymentIntent.metadata?.source_arbitration_v === "1") {
    const metadata = paymentIntent.metadata;
    const runId = metadata.autopay_run_id?.trim();
    const managerId = metadata.manager_user_id?.trim();
    const residentEmail = metadata.resident_email?.trim().toLowerCase();
    const principal = Number(metadata.subtotal_cents);
    const gross = Number(metadata.total_cents);
    const processing = Number(metadata.processing_fee_cents);
    const net = Number(metadata.manager_payout_cents);
    const attempt = Number(metadata.autopay_attempt);
    if (!runId || !managerId || !residentEmail || metadata.charge_id !== chargeId ||
        metadata.purpose !== HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE ||
        !["ach", "card"].includes(metadata.payment_method ?? "") ||
        !["resident", "manager", "proplane"].includes(metadata.fee_payer ?? "") ||
        ![principal, gross, processing, net, attempt].every(Number.isSafeInteger) ||
        principal < 100 || processing < 0 || gross !== principal + processing ||
        metadata.principal_cents !== String(principal) ||
        net <= 0 || net > principal || attempt < 1 ||
        metadata.platform_hold !== "1" || metadata.hold_amount_cents !== String(net) ||
        paymentIntent.currency !== "usd" || paymentIntent.amount !== gross ||
        paymentIntent.amount_received !== gross || paymentIntent.transfer_data?.destination ||
        paymentIntent.application_fee_amount) {
      return { ok: false };
    }
    const { data: run, error: runError } = await db.from("resident_autopay_runs")
      .select("id,charge_id,manager_id,resident_user_id,status,attempt,stripe_payment_intent_id")
      .eq("id", runId).maybeSingle();
    if (runError || !run || run.charge_id !== chargeId || run.manager_id !== managerId ||
        Number(run.attempt) !== attempt || !["claimed", "succeeded"].includes(run.status) ||
        (run.stripe_payment_intent_id && run.stripe_payment_intent_id !== paymentIntent.id)) {
      // A deleted run loses its slot. The captured PI needs provider/books
      // reconciliation; a reused email must not revive the old authority.
      return { ok: false };
    }
    const { data: before, error: beforeError } = await db.from("portal_household_charge_records")
      .select("id,row_data,status").eq("id", chargeId).maybeSingle();
    const charge = before?.row_data as HouseholdCharge | null;
    if (beforeError || !charge || charge.managerUserId !== managerId ||
        charge.residentEmail.trim().toLowerCase() !== residentEmail) return { ok: false };
    if (run.status !== "succeeded") {
      await assertFreshHouseholdCapturedSource(getStripe(), { paymentIntent });
    }
    const { data: settled, error: settleError } = await db.rpc("settle_resident_autopay_run", {
      p_run_id: runId, p_attempt: attempt, p_payment_intent_id: paymentIntent.id,
      p_principal_cents: principal, p_resident_email: residentEmail,
    });
    if (settleError || !settled || typeof settled !== "object") return { ok: false };
    const result = settled as { row?: HouseholdCharge; newlySettled?: boolean };
    if (!result.row?.id || result.row.id !== chargeId ||
        typeof result.newlySettled !== "boolean") return { ok: false };
    await completeHouseholdChargePaid(db, result.row, charge.status, paymentIntent.id,
      paymentIntent.id, result.newlySettled);
    return { ok: true, alreadyPaid: !result.newlySettled };
  }
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
