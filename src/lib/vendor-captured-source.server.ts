import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findPlatformHoldByPaymentIntent } from "@/lib/stripe-platform-hold.server";
import { verifyPlatformHoldSourceRefundHistory, type HeldSourceRow } from "@/lib/platform-hold-release.server";
import { attestPlatformDestinationSource } from "@/lib/platform-destination-source.server";

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

/** Historical Checkout has no frozen v1 claim. Verify its actual captured
 * destination or held Charge before replaying its original accounting path. */
export async function verifyLegacyVendorCheckoutSource(
  db: SupabaseClient, stripe: Stripe, session: Stripe.Checkout.Session,
  terms: { purpose: string; managerUserId: string; vendorUserId: string;
    principalCents: number; platformFeeCents: number; sourceId: string },
): Promise<{ chargeId: string }> {
  const meta = session.metadata ?? {};
  const processing = Number(meta.processing_fee_cents);
  const net = terms.principalCents - terms.platformFeeCents;
  if (meta.source_arbitration_v || meta.purpose !== terms.purpose ||
      meta.manager_user_id !== terms.managerUserId ||
      meta.vendor_user_id !== terms.vendorUserId ||
      meta.invoice_cents !== String(terms.principalCents) ||
      meta.platform_fee_cents !== String(terms.platformFeeCents) ||
      !Number.isSafeInteger(processing) || processing < 0 ||
      !Number.isSafeInteger(net) || net <= 0 ||
      session.amount_total !== terms.principalCents + processing ||
      session.currency?.toLowerCase() !== "usd" || session.status !== "complete" ||
      session.payment_status !== "paid") {
    throw new Error("Historical vendor Checkout does not match the claimed payment.");
  }
  const piId = idOf(session.payment_intent);
  if (!piId) throw new Error("Historical vendor Checkout has no PaymentIntent.");
  const pi = await stripe.paymentIntents.retrieve(piId);
  const chargeId = idOf(pi.latest_charge);
  if (!chargeId || pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.amount_received !== session.amount_total ||
      pi.metadata?.purpose !== terms.purpose ||
      pi.metadata?.manager_user_id !== terms.managerUserId ||
      pi.metadata?.vendor_user_id !== terms.vendorUserId ||
      pi.metadata?.invoice_cents !== String(terms.principalCents) ||
      pi.metadata?.platform_fee_cents !== String(terms.platformFeeCents)) {
    throw new Error("Historical vendor PaymentIntent differs from the claim.");
  }
  const charge = await stripe.charges.retrieve(chargeId);
  if (idOf(charge.payment_intent) !== pi.id || !charge.paid ||
      charge.status !== "succeeded" || charge.currency !== "usd" ||
      charge.amount !== session.amount_total || charge.disputed) {
    throw new Error("Historical vendor Charge differs from the captured payment.");
  }
  if (meta.platform_hold === "1") {
    if (meta.hold_amount_cents !== String(net) ||
        pi.metadata?.platform_hold !== "1" || pi.metadata?.hold_amount_cents !== String(net) ||
        pi.transfer_data?.destination || pi.application_fee_amount ||
        charge.transfer_data?.destination || charge.application_fee_amount) {
      throw new Error("Historical vendor hold has inconsistent recipient terms.");
    }
    const { data: existing, error } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,source,source_id,amount_cents,stripe_charge_id")
      .eq("source", "vendor_invoice").eq("source_id", terms.sourceId).maybeSingle();
    if (error || (existing && (existing.owner_user_id !== terms.vendorUserId ||
        existing.owner_role !== "vendor" || existing.amount_cents !== net ||
        (existing.stripe_charge_id && existing.stripe_charge_id !== chargeId)))) {
      throw new Error("Historical vendor hold differs from its captured Charge.");
    }
    const refunds = await stripe.refunds.list({ charge: chargeId, limit: 1 });
    if (charge.amount_refunded || refunds.data.length || refunds.has_more) {
      throw new Error("Historical vendor hold has refund history requiring review.");
    }
  } else {
    const destination = idOf(pi.transfer_data?.destination);
    if (!destination || meta.platform_hold || meta.hold_amount_cents ||
        !Number.isSafeInteger(net)) {
      throw new Error("Historical vendor destination is ambiguous.");
    }
    await attestPlatformDestinationSource(stripe, {
      paymentIntent: pi, charge, ownerUserId: terms.vendorUserId,
      expectedGrossCents: session.amount_total,
      expectedRecipientNetCents: net,
      expectedDestinationAccountId: destination,
    });
  }
  return { chargeId };
}

/** Bind a new vendor payout to one central captured Charge before paid mutation. */
export async function creditVerifiedVendorCheckoutSource(
  db: SupabaseClient, stripe: Stripe, session: Stripe.Checkout.Session,
  terms: { purpose: string; managerUserId: string; vendorUserId: string;
    sourceId: string; componentId: string; componentKind: "vendor_invoice" | "vendor_service";
    principalCents: number; platformFeeCents: number },
): Promise<{ holdId: string; chargeId: string; recipientNetCents: number }> {
  const meta = session.metadata ?? {};
  const net = terms.principalCents - terms.platformFeeCents;
  const processing = Number(meta.processing_fee_cents);
  if (meta.source_arbitration_v !== "1" || meta.purpose !== terms.purpose ||
      meta.manager_user_id !== terms.managerUserId ||
      meta.vendor_user_id !== terms.vendorUserId ||
      meta.invoice_cents !== String(terms.principalCents) ||
      meta.platform_fee_cents !== String(terms.platformFeeCents) ||
      meta.platform_hold !== "1" || meta.hold_amount_cents !== String(net) ||
      meta.fee_payer !== "resident" || meta.funding_model ||
      !Number.isSafeInteger(terms.principalCents) || terms.principalCents < 100 ||
      !Number.isSafeInteger(terms.platformFeeCents) || terms.platformFeeCents < 0 ||
      net <= 0 || !Number.isSafeInteger(processing) || processing < 0 ||
      session.amount_total !== terms.principalCents + processing ||
      session.currency?.toLowerCase() !== "usd" || session.status !== "complete" ||
      session.payment_status !== "paid") {
    throw new Error("Vendor Checkout differs from its frozen central source terms.");
  }
  const piId = idOf(session.payment_intent);
  if (!piId) throw new Error("Vendor Checkout has no captured PaymentIntent.");
  const pi = await stripe.paymentIntents.retrieve(piId);
  const chargeId = idOf(pi.latest_charge);
  if (!chargeId || pi.status !== "succeeded" || pi.currency !== "usd" ||
      pi.amount_received !== session.amount_total ||
      pi.metadata?.source_arbitration_v !== "1" ||
      pi.metadata?.purpose !== terms.purpose ||
      pi.metadata?.manager_user_id !== terms.managerUserId ||
      pi.metadata?.vendor_user_id !== terms.vendorUserId ||
      pi.metadata?.invoice_cents !== String(terms.principalCents) ||
      pi.metadata?.platform_fee_cents !== String(terms.platformFeeCents) ||
      pi.metadata?.hold_amount_cents !== String(net) ||
      pi.metadata?.fee_payer !== "resident" || pi.transfer_data?.destination ||
      pi.application_fee_amount) {
    throw new Error("Vendor PaymentIntent differs from the frozen central source.");
  }
  const charge = await stripe.charges.retrieve(chargeId);
  if (idOf(charge.payment_intent) !== pi.id || !charge.paid ||
      charge.status !== "succeeded" || charge.currency !== "usd" ||
      charge.amount !== session.amount_total || charge.disputed) {
    throw new Error("Vendor captured Charge differs from its PaymentIntent.");
  }
  const existing = await findPlatformHoldByPaymentIntent(db, pi.id);
  if (existing) {
    const { data: verified, error: verifiedError } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id,original_amount_cents,source_charge_gross_cents,source_payment_intent_id,source_verified_at")
      .eq("id", existing.id).maybeSingle();
    if (verifiedError || !verified || verified.owner_user_id !== terms.vendorUserId ||
        verified.owner_role !== "vendor" || verified.source !== "vendor_invoice" ||
        verified.stripe_charge_id !== charge.id || !verified.source_verified_at) {
      throw new Error("Vendor source has an unverified prior allocation.");
    }
    await verifyPlatformHoldSourceRefundHistory(db, stripe, verified as HeldSourceRow);
  } else {
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
    if (charge.refunded || (charge.amount_refunded ?? 0) > 0 ||
        refunds.data.length || refunds.has_more) {
      throw new Error("Refunded vendor source needs allocation reconciliation.");
    }
  }
  const { data: credited, error: creditError } = await db.rpc("credit_verified_platform_hold", {
    p_owner: terms.vendorUserId, p_owner_role: "vendor",
    p_source: "vendor_invoice", p_source_id: terms.sourceId,
    p_charge: charge.id, p_payment_intent: pi.id,
    p_charge_gross: session.amount_total, p_principal: terms.principalCents,
    p_original_net: net, p_fee_payer: "manager",
    p_components: [{ source_id: terms.componentId, kind: terms.componentKind,
      liability_class: "vendor", principal_cents: terms.principalCents,
      recipient_net_cents: net }],
  });
  const result = Array.isArray(credited) ? credited[0] : credited;
  if (creditError || !result?.hold_id || (existing && existing.id !== result.hold_id)) {
    throw new Error("Vendor captured source could not be credited.");
  }
  return { holdId: result.hold_id, chargeId: charge.id, recipientNetCents: net };
}
