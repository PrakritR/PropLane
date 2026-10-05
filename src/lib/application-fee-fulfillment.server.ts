import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge } from "@/lib/household-charges";
import { syncLedgerChargeOnlyEntry, syncLedgerPaymentEntry } from "@/lib/reports/ledger-sync";
import { cancelFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
import { creditPlatformHold } from "@/lib/stripe-platform-hold.server";
import { findPlatformHold } from "@/lib/stripe-platform-hold.server";
import { parseMoneyAmount } from "@/lib/parse-money";
import { promoteIncompleteApplicationAfterFeePaid } from "@/lib/promote-incomplete-application-after-fee.server";
import type { ApplicationFeeClaim } from "@/lib/application-fee-payment-claim.server";

function customerEmail(session: Stripe.Checkout.Session): string {
  return String(session.customer_details?.email ?? session.customer_email ?? "").trim().toLowerCase();
}

async function actualCharge(stripe: Stripe, session: Stripe.Checkout.Session, claim: ApplicationFeeClaim) {
  const rawPi = session.payment_intent;
  const piId = typeof rawPi === "string" ? rawPi : rawPi?.id;
  if (!piId) throw new Error("Paid application Checkout has no PaymentIntent.");
  const pi = await stripe.paymentIntents.retrieve(piId);
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
  if (!chargeId || pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.amount_received !== claim.payer_total_cents ||
      pi.metadata?.purpose !== "rental_application_fee" ||
      pi.metadata?.application_id !== claim.application_id ||
      pi.metadata?.attempt_token !== claim.attempt_token ||
      pi.metadata?.manager_user_id !== claim.manager_user_id) {
    throw new Error("Application PaymentIntent does not match the paid claim.");
  }
  const charge = await stripe.charges.retrieve(chargeId);
  const chargePi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (chargePi !== pi.id || !charge.paid || charge.status !== "succeeded" ||
      charge.currency !== "usd" || charge.amount !== claim.payer_total_cents) {
    throw new Error("Application charge does not match the paid claim.");
  }
  const expectedDestination = claim.provider_params.destinationAccountId?.trim() || "";
  const actualDestination = typeof pi.transfer_data?.destination === "string"
    ? pi.transfer_data.destination : pi.transfer_data?.destination?.id ?? "";
  if (actualDestination !== expectedDestination) {
    throw new Error("Application payment destination changed after checkout.");
  }
  return { pi, charge };
}

function paidChargeData(claim: ApplicationFeeClaim, session: Stripe.Checkout.Session, charge: Stripe.Charge): HouseholdCharge {
  const metadata = claim.provider_params.metadata;
  const paidAt = new Date(charge.created * 1000).toISOString();
  return {
    id: claim.charge_id,
    applicationId: claim.application_id,
    createdAt: claim.created_at,
    residentEmail: claim.resident_email,
    residentName: metadata.resident_name?.trim() || "Applicant",
    residentUserId: null,
    propertyId: claim.property_id,
    propertyLabel: claim.provider_params.productDescription?.trim() || "Listing",
    managerUserId: claim.manager_user_id,
    kind: "application_fee",
    title: "Application fee",
    amountLabel: `$${(claim.principal_cents / 100).toFixed(2)}`,
    balanceLabel: "$0.00",
    status: "paid",
    paidAt,
    paidAmountCents: claim.payer_total_cents,
    blocksLeaseUntilPaid: false,
    applicationFeeBasis: {
      roomId: metadata.fee_room_id?.trim() || "",
      leaseTerm: metadata.fee_lease_term?.trim() || "",
      source: metadata.fee_source?.trim() || "",
    },
    stripeCheckoutSessionId: session.id,
    stripePaymentStatus: session.payment_status,
  } as HouseholdCharge;
}

/** One financial fulfillment for webhook and in-app return. The application
 * can still need human help to submit answers; captured principal and the
 * recipient's ledger/hold settle independently of that later promotion. */
export async function fulfillClaimedApplicationFeePayment(
  db: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<{ chargeId: string; alreadyPaid: boolean; managerUserId: string }> {
  const applicationId = session.metadata?.application_id?.trim() ?? "";
  const attemptToken = session.metadata?.attempt_token?.trim() ?? "";
  if (!applicationId || !attemptToken || session.mode !== "payment" ||
      session.metadata?.purpose !== "rental_application_fee" ||
      ["1", "true"].includes(session.metadata?.includes_holding_deposit ?? "") ||
      session.status !== "complete" || session.payment_status !== "paid" ||
      session.currency?.toLowerCase() !== "usd") {
    throw new Error("Application fee session is not a paid claimed payment.");
  }
  const { data, error } = await db.from("application_fee_payment_claims")
    .select("*").eq("application_id", applicationId).maybeSingle();
  if (error || !data) throw new Error("Paid application fee has no durable source claim; reconcile it before fulfillment.");
  const claim = data as ApplicationFeeClaim;
  if (!claim.created_at || Number.isNaN(Date.parse(claim.created_at))) {
    throw new Error("Application payment origin date needs source review.");
  }
  if (claim.attempt_token !== attemptToken ||
      (claim.stripe_session_id && claim.stripe_session_id !== session.id) ||
      session.metadata?.manager_user_id !== claim.manager_user_id ||
      session.metadata?.property_id !== claim.property_id ||
      session.metadata?.resident_email?.toLowerCase() !== claim.resident_email ||
      session.metadata?.fee_cents !== String(claim.principal_cents) ||
      session.metadata?.manager_payout_cents !== String(claim.recipient_net_cents) ||
      session.metadata?.processing_fee_cents !== String(claim.processing_fee_cents) ||
      session.metadata?.fee_payer !== claim.provider_params.feePayer ||
      session.metadata?.service_fee_cents !== String(claim.provider_params.fixedFeeBreakdown?.serviceFeeCents) ||
      session.metadata?.subtotal_cents !== String(claim.principal_cents) ||
      session.amount_total !== claim.payer_total_cents ||
      customerEmail(session) !== claim.resident_email) {
    throw new Error("Paid application Checkout does not match its source claim.");
  }
  for (const key of ["application_template_id", "fee_room_id", "fee_lease_term",
    "fee_source", "fee_bundle_id", "fee_rental_type", "fee_basis_v"] as const) {
    if (session.metadata?.[key] !== claim.provider_params.metadata[key]) {
      throw new Error("Paid application fee basis differs from its saved quote.");
    }
  }
  const { charge } = await actualCharge(stripe, session, claim);
  const isHold = !claim.provider_params.destinationAccountId;
  if ((session.metadata?.platform_hold === "1") !== isHold ||
      (isHold && session.metadata?.hold_amount_cents !== String(claim.recipient_net_cents))) {
    throw new Error("Paid application recipient settlement does not match the source claim.");
  }
  const chargeData = paidChargeData(claim, session, charge);
  const { data: settled, error: settleError } = await db.rpc("settle_application_fee_checkout", {
    p_application_id: applicationId, p_attempt_token: attemptToken,
    p_session_id: session.id, p_stripe_charge_id: charge.id,
    p_charge_row_data: chargeData,
  });
  if (settleError || settled !== claim.charge_id) throw new Error(settleError?.message ?? "Could not settle application payment.");

  const { data: stored, error: storedError } = await db.from("portal_household_charge_records")
    .select("row_data").eq("id", claim.charge_id).maybeSingle();
  if (storedError || !stored?.row_data) throw new Error("Paid application fee charge could not be reloaded.");
  const durableCharge = stored.row_data as HouseholdCharge;
  if (durableCharge.id !== claim.charge_id || durableCharge.applicationId !== claim.application_id ||
      durableCharge.managerUserId !== claim.manager_user_id ||
      durableCharge.propertyId !== claim.property_id ||
      durableCharge.residentEmail.trim().toLowerCase() !== claim.resident_email ||
      durableCharge.kind !== "application_fee" ||
      !["paid", "refunded"].includes(durableCharge.status) ||
      Math.round(parseMoneyAmount(durableCharge.amountLabel) * 100) !== claim.principal_cents ||
      durableCharge.paidAmountCents !== claim.payer_total_cents ||
      durableCharge.stripeCheckoutSessionId !== session.id ||
      durableCharge.paidAt !== chargeData.paidAt) {
    throw new Error("Stored application payment changed after provider settlement.");
  }
  await syncLedgerChargeOnlyEntry(db, durableCharge);
  await syncLedgerPaymentEntry(db, durableCharge, durableCharge.paidAt, session.id);
  const { data: ledgerRows, error: ledgerError } = await db.from("ledger_entries")
    .update({ stripe_charge_id: charge.id, stripe_fee_cents: 0,
      axis_fee_cents: 0, net_cents: claim.recipient_net_cents,
      updated_at: new Date().toISOString() })
    .eq("manager_user_id", claim.manager_user_id)
    .eq("source_charge_id", claim.charge_id)
    .eq("entry_type", "payment")
    .eq("stripe_checkout_session_id", session.id)
    .select("id");
  if (ledgerError || ledgerRows?.length !== 1) {
    throw new Error("Application payment ledger enrichment needs repair.");
  }
  if (isHold) {
    const hold = await findPlatformHold(db, "application_fee", session.id);
    if (hold && (hold.ownerUserId !== claim.manager_user_id || hold.ownerRole !== "manager" ||
        (hold.stripeChargeId && hold.stripeChargeId !== charge.id))) {
      throw new Error("Application hold does not match its paid source.");
    }
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
    const hasRefundEvidence = charge.refunded || (charge.amount_refunded ?? 0) > 0 ||
      charge.disputed || refunds.data.length > 0 || refunds.has_more;
    if (!hold && hasRefundEvidence) {
      throw new Error("Refunded application source needs hold reconciliation before credit.");
    }
    // A redelivered original payment cannot replenish a hold reduced by a
    // later partial/full refund. The refund engine owns its remaining amount.
    if (!hold || !hasRefundEvidence) {
      await creditPlatformHold(db, {
        ownerUserId: claim.manager_user_id,
        ownerRole: "manager",
        source: "application_fee",
        sourceId: session.id,
        amountCents: claim.recipient_net_cents,
        stripeChargeId: charge.id,
      });
    }
  }
  await cancelFuturePaymentRemindersForCharge(db, claim.manager_user_id, claim.charge_id);
  return { chargeId: claim.charge_id, alreadyPaid: claim.status === "settled", managerUserId: claim.manager_user_id };
}

/** Repair only the financial record of a pre-claim Checkout. A paid household
 * charge already bound to this exact session is the source of authority. Old
 * email/property matching cannot establish which application was paid, so this
 * path never creates a charge or promotes an application. */
export async function repairLegacyBoundApplicationFeePayment(
  db: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<{ chargeId: string; alreadyPaid: true; managerUserId: string; legacy: true }> {
  const meta = session.metadata ?? {};
  const email = customerEmail(session);
  const principal = Number(meta.fee_cents);
  const processing = Number(meta.processing_fee_cents);
  const serviceFee = Number(meta.service_fee_cents);
  const payout = Number(meta.manager_payout_cents);
  if (meta.application_id || meta.attempt_token || meta.purpose !== "rental_application_fee" ||
      session.mode !== "payment" || session.status !== "complete" ||
      session.payment_status !== "paid" || session.currency?.toLowerCase() !== "usd" ||
      ["1", "true"].includes(meta.includes_holding_deposit ?? "") ||
      !email.includes("@") || email !== meta.resident_email?.trim().toLowerCase() ||
      !meta.manager_user_id || !meta.property_id ||
      meta.platform_hold !== "1" ||
      !Number.isSafeInteger(principal) || principal <= 0 ||
      !Number.isSafeInteger(processing) || processing < 0 ||
      !Number.isSafeInteger(serviceFee) || serviceFee < 0 ||
      !Number.isSafeInteger(payout) || payout <= 0 || payout > principal ||
      Number(meta.subtotal_cents) !== principal ||
      !["resident", "manager", "proplane"].includes(meta.fee_payer ?? "") ||
      (meta.fee_payer === "resident" && (serviceFee !== processing || payout !== principal)) ||
      (meta.fee_payer === "manager" && (processing !== 0 || payout !== principal - serviceFee)) ||
      (meta.fee_payer === "proplane" && (processing !== 0 || serviceFee !== 0 || payout !== principal)) ||
      Number(meta.axis_fee_cents ?? "0") !== 0 ||
      session.amount_total !== principal + (meta.fee_payer === "resident" ? processing : 0) ||
      (session.amount_subtotal != null && session.amount_subtotal !== session.amount_total) ||
      meta.hold_amount_cents !== String(payout)) {
    throw new Error("Earlier application payment needs exact source review.");
  }
  const { data: matches, error: matchError } = await db.from("portal_household_charge_records")
    .select("id,manager_user_id,resident_email,property_id,kind,status,created_at,row_data")
    .eq("row_data->>stripeCheckoutSessionId", session.id).limit(2);
  if (matchError || matches?.length !== 1) {
    throw new Error("Earlier application payment has no unique paid session-bound charge.");
  }
  const row = matches[0];
  const saved = row.row_data as (HouseholdCharge & {
    stripeCheckoutSessionId?: string;
    stripePaymentStatus?: string;
  }) | null;
  if (row.manager_user_id !== meta.manager_user_id || row.property_id !== meta.property_id ||
      row.resident_email?.trim().toLowerCase() !== email || row.kind !== "application_fee" ||
      row.status !== "paid" || !saved || saved.id !== row.id ||
      saved.kind !== "application_fee" || saved.status !== "paid" ||
      saved.managerUserId !== meta.manager_user_id || saved.propertyId !== meta.property_id ||
      saved.residentEmail?.trim().toLowerCase() !== email ||
      saved.stripeCheckoutSessionId !== session.id || saved.stripePaymentStatus !== "paid" ||
      !saved.paidAt || Number.isNaN(Date.parse(saved.paidAt)) ||
      Math.round(parseMoneyAmount(saved.amountLabel) * 100) !== principal ||
      (saved.paidAmountCents != null && saved.paidAmountCents !== session.amount_total)) {
    throw new Error("Earlier application charge does not match its paid session.");
  }
  const originatedAt = typeof saved.createdAt === "string" && !Number.isNaN(Date.parse(saved.createdAt))
    ? saved.createdAt : row.created_at;
  if (!originatedAt || Number.isNaN(Date.parse(originatedAt))) {
    throw new Error("Earlier application charge origin date needs review.");
  }
  const { data: property, error: ownerError } = await db.from("manager_property_records")
    .select("manager_user_id").eq("id", row.property_id).maybeSingle();
  if (ownerError || property?.manager_user_id !== row.manager_user_id) {
    throw new Error("Earlier application payment owner cannot be verified.");
  }

  const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!piId) throw new Error("Earlier paid application has no PaymentIntent.");
  const pi = await stripe.paymentIntents.retrieve(piId);
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
  const destination = typeof pi.transfer_data?.destination === "string"
    ? pi.transfer_data.destination : pi.transfer_data?.destination?.id ?? "";
  if (pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.amount_received !== session.amount_total || !chargeId ||
      pi.metadata?.purpose !== "rental_application_fee" ||
      pi.metadata?.manager_user_id !== row.manager_user_id ||
      pi.metadata?.property_id !== row.property_id ||
      pi.metadata?.resident_email?.trim().toLowerCase() !== email ||
      pi.metadata?.platform_hold !== "1" ||
      pi.metadata?.hold_amount_cents !== String(payout) ||
      destination || (pi.application_fee_amount ?? 0) !== 0) {
    throw new Error("Earlier application PaymentIntent does not match the paid charge.");
  }
  const charge = await stripe.charges.retrieve(chargeId);
  const chargePi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (chargePi !== pi.id || !charge.paid || charge.status !== "succeeded" ||
      charge.currency !== "usd" || charge.amount !== session.amount_total ||
      charge.amount_refunded !== 0 || charge.refunded || charge.disputed) {
    throw new Error("Earlier application Stripe charge needs refund or source review.");
  }
  // A pending or failed refund is also an unresolved money reservation. Do not
  // expose the full original principal as a new hold while it is in flight.
  const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
  if (refunds.data.length || refunds.has_more) {
    throw new Error("Earlier application refund needs source review before hold repair.");
  }
  const hold = await findPlatformHold(db, "application_fee", session.id);
  if (hold && (hold.ownerUserId !== row.manager_user_id || hold.ownerRole !== "manager" ||
      (hold.stripeChargeId && hold.stripeChargeId !== charge.id) ||
      hold.amountCents !== payout || hold.status === "refunded")) {
    throw new Error("Earlier application hold belongs to another source or amount.");
  }

  await syncLedgerChargeOnlyEntry(db, { ...saved, createdAt: originatedAt });
  await syncLedgerPaymentEntry(db, saved, saved.paidAt, session.id);
  const { data: ledgerRows, error: ledgerError } = await db.from("ledger_entries")
    .update({ stripe_charge_id: charge.id, stripe_fee_cents: 0,
      axis_fee_cents: 0, net_cents: payout, updated_at: new Date().toISOString() })
    .eq("manager_user_id", row.manager_user_id).eq("source_charge_id", row.id)
    .eq("entry_type", "payment").eq("stripe_checkout_session_id", session.id).select("id");
  if (ledgerError || ledgerRows?.length !== 1) {
    throw new Error("Earlier application payment ledger needs repair.");
  }
  await creditPlatformHold(db, { ownerUserId: row.manager_user_id, ownerRole: "manager",
    source: "application_fee", sourceId: session.id,
    amountCents: payout, stripeChargeId: charge.id });
  await cancelFuturePaymentRemindersForCharge(db, row.manager_user_id, row.id);
  return { chargeId: row.id, alreadyPaid: true, managerUserId: row.manager_user_id, legacy: true };
}

export async function fulfillApplicationFeePayment(
  db: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
) {
  if (!session.metadata?.application_id && !session.metadata?.attempt_token) {
    return repairLegacyBoundApplicationFeePayment(db, stripe, session);
  }
  return fulfillClaimedApplicationFeePayment(db, stripe, session);
}

export async function promoteClaimedApplicationAfterFee(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
) {
  const promoted = await promoteIncompleteApplicationAfterFeePaid(db, session);
  const status = promoted.ok && (promoted.promoted || promoted.reason === "already_submitted")
    ? "complete" : "needs_review";
  const reason = promoted.ok
    ? (promoted.promoted ? "submitted" : promoted.reason)
    : "promotion_error";
  const { data, error } = await db.rpc("record_application_fee_promotion_result", {
    p_application_id: session.metadata?.application_id,
    p_session_id: session.id, p_status: status, p_reason: reason,
  });
  if (error || data !== true) throw new Error("Could not record application promotion outcome.");
  return promoted;
}
