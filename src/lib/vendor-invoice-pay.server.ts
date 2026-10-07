import "server-only";

import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import { creditHoldFromPaidSession } from "@/lib/stripe-platform-hold.server";
import { directInvoiceHoldSourceId } from "@/lib/stripe-platform-hold";
import { creditVerifiedVendorCheckoutSource, verifyLegacyVendorCheckoutSource } from "@/lib/vendor-captured-source.server";
import { releaseVerifiedPlatformHoldsForOwner } from "@/lib/platform-hold-release.server";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { vendorPayFeeCents } from "@/lib/platform-fees";
import { residentServiceFeeBreakdown } from "@/lib/payment-policy";
import { recordVendorBankingChargeAndFee } from "@/lib/vendor-banking/ledger.server";
import { recordVendorServiceFeeRevenue } from "@/lib/vendor-banking/platform-revenue.server";
import { createBillFromVendorInvoice } from "@/lib/manager-bills.server";
import { assertNoCrossRailPayout, authorizeOutgoingInvoice, settleInvoicePayment } from "@/lib/vendor-invoice-settlement.server";
import { isVendorInvoicePaymentRefusal } from "@/lib/vendor-invoices";

export const VENDOR_INVOICE_DIRECT_PAY_PURPOSE = "vendor_invoice_direct_pay";

export type StartInvoicePayFailure = { ok: false; status: number; error: string };
export type StartInvoicePaySuccess = {
  ok: true;
  clientSecret: string;
  sessionId: string;
  invoiceCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  totalCents: number;
};

/**
 * Manager pays an approved/scheduled vendor invoice in-app — "Request
 * payment" (VD48/49). Standalone vendor invoices (no work order) use this
 * path; work-order-linked settlement stays on `vendor-invoice-settlement.server.ts`.
 */
export async function startVendorInvoicePayCheckout(
  db: SupabaseClient,
  opts: { invoiceId: string; managerUserId: string; managerEmail: string; paymentMethod: "card" | "ach" },
): Promise<StartInvoicePaySuccess | StartInvoicePayFailure> {
  const { data: invoice, error } = await db
    .from("vendor_invoices")
    .select("id, manager_user_id, vendor_user_id, total_cents, status, invoice_number, memo, payment_claim, checkout_session_id, stripe_checkout_provider_terms, bill_id, work_order_id, estimate_visit_bid_id")
    .eq("id", opts.invoiceId)
    .eq("manager_user_id", opts.managerUserId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!invoice) return { ok: false, status: 404, error: "Invoice not found." };
  const row = invoice as {
    id: string;
    manager_user_id: string;
    vendor_user_id: string;
    total_cents: number;
    status: string;
    invoice_number: string | null;
    memo: string | null;
    payment_claim: string | null;
    checkout_session_id: string | null;
    stripe_checkout_provider_terms: unknown;
    bill_id: string | null;
    work_order_id: string | null;
    estimate_visit_bid_id: string | null;
  };
  if (row.status !== "approved" && row.status !== "scheduled") {
    return { ok: false, status: 409, error: `Invoice is ${row.status}; it must be approved before it can be paid.` };
  }
  const invoiceCents = Math.round(Number(row.total_cents) || 0);
  if (invoiceCents < 100) return { ok: false, status: 400, error: "Invoice total must be at least $1.00." };
  if (row.payment_claim && row.payment_claim !== "stripe") {
    return { ok: false, status: 409, error: "Payment already started using another source." };
  }
  const preexistingCheckout = row.checkout_session_id;
  const preexistingTerms = row.stripe_checkout_provider_terms;

  // A service-linked invoice still needs the service/workspace/assignee checks. The cross-rail
  // read is only the FRIENDLY pre-check: the claim RPC below and the `vendor_payouts` cross-rail
  // trigger (migration 20261004160000) are what arbitrate a race, so a refusal from either is
  // the same 409.
  try {
    await authorizeOutgoingInvoice(db, opts.managerUserId, row.id);
    if (row.payment_claim !== "stripe") await assertNoCrossRailPayout(db, row);
  } catch (e) {
    if (isVendorInvoicePaymentRefusal(e)) return { ok: false, status: 409, error: e.message };
    // A table that could not be READ is a fault, not a double-pay refusal.
    return { ok: false, status: 500, error: e instanceof Error ? e.message : "Could not authorize this invoice." };
  }
  if (row.status === "approved" && !row.bill_id) await createBillFromVendorInvoice(db, opts.managerUserId, row.id);

  const stripe = getStripe();
  const claim = await db.rpc("claim_vendor_invoice_stripe_checkout", {
    p_invoice: row.id,
    p_manager: opts.managerUserId,
    p_attempt: `attempt:${opts.paymentMethod}:${randomUUID()}`,
  });
  if (claim.error || typeof claim.data !== "string") {
    return { ok: false, status: 409, error: claim.error?.message ?? "Could not claim invoice payment." };
  }
  const attempt = claim.data;
  if (!attempt.startsWith("attempt:")) {
    const existing = await stripe.checkout.sessions.retrieve(attempt);
    if (existing.status === "expired") {
      await releaseFailedVendorInvoiceCheckout(db, existing);
      return { ok: false, status: 409, error: "The prior payment attempt expired. Try again to start a new checkout." };
    }
    if (existing.status !== "open" || existing.metadata?.payment_method !== opts.paymentMethod || !existing.client_secret) {
      return { ok: false, status: 409, error: "A payment is already in progress for this invoice. Check its status before trying another method." };
    }
    return {
      ok: true,
      clientSecret: existing.client_secret,
      sessionId: existing.id,
      invoiceCents,
      platformFeeCents: Number(existing.metadata?.platform_fee_cents ?? 0),
      processingFeeCents: Number(existing.metadata?.processing_fee_cents ?? 0),
      totalCents: existing.amount_total ?? 0,
    };
  }
  if (!attempt.startsWith(`attempt:${opts.paymentMethod}:`)) {
    return { ok: false, status: 409, error: "A payment is already starting with another method." };
  }

  if (preexistingCheckout?.startsWith("attempt:") && !preexistingTerms) {
    return { ok: false, status: 409, error: "The prior invoice checkout needs provider-term reconciliation." };
  }
  const platformFeeCents = vendorBankingEnabled() ? vendorPayFeeCents(invoiceCents) : 0;
  const origin = resolveShareableAppOrigin();
  const label = row.invoice_number ? `Invoice ${row.invoice_number}` : row.memo?.trim() || "Vendor invoice";
  const candidateRequest = {
    idempotencyKey: `vendor-invoice:${row.id}:${attempt}`,
    residentEmail: opts.managerEmail,
    amountCents: invoiceCents,
    productName: label.slice(0, 120),
    productDescription: "Invoice total to the vendor. You pay Stripe’s processing cost.",
    metadata: {
      purpose: VENDOR_INVOICE_DIRECT_PAY_PURPOSE,
      invoice_id: row.id,
      manager_user_id: row.manager_user_id,
      vendor_user_id: row.vendor_user_id,
      invoice_cents: String(invoiceCents),
      platform_fee_cents: String(platformFeeCents),
      source_arbitration_v: "1",
      checkout_attempt: attempt,
    },
    destinationAccountId: null,
    mode: "embedded",
    paymentMethod: opts.paymentMethod,
    forceExplicitCard: opts.paymentMethod === "card",
    fixedFeeBreakdown: residentServiceFeeBreakdown(invoiceCents, opts.paymentMethod, "resident"),
    feePayer: "resident",
    extraApplicationFeeCents: platformFeeCents,
    returnUrl: `${origin}/portal/finances?invoice_pay=success&session_id={CHECKOUT_SESSION_ID}`,
  } as const;
  const { data: frozenRaw, error: freezeError } = await db.rpc("freeze_vendor_invoice_stripe_checkout_terms", {
    p_invoice: row.id, p_manager: opts.managerUserId, p_attempt: attempt,
    p_terms: { invoiceId: row.id, managerUserId: opts.managerUserId,
      vendorUserId: row.vendor_user_id, invoiceCents, request: candidateRequest },
  });
  const frozen = frozenRaw as { invoiceId?: string; managerUserId?: string;
    vendorUserId?: string; invoiceCents?: number;
    request?: Parameters<typeof createAxisAchCheckoutSession>[1] } | null;
  const frozenFeeCents = Number(frozen?.request?.extraApplicationFeeCents);
  if (freezeError || !frozen?.request || frozen.invoiceId !== row.id ||
      frozen.managerUserId !== opts.managerUserId ||
      frozen.vendorUserId !== row.vendor_user_id || frozen.invoiceCents !== invoiceCents ||
      frozen.request.idempotencyKey !== candidateRequest.idempotencyKey ||
      frozen.request.destinationAccountId ||
      !Number.isSafeInteger(frozenFeeCents) || frozenFeeCents < 0 ||
      frozen.request.metadata?.platform_fee_cents !== String(frozenFeeCents) ||
      frozen.request.forceExplicitCard !== (opts.paymentMethod === "card") ||
      !frozen.request.fixedFeeBreakdown ||
      frozen.request.fixedFeeBreakdown.totalCents !==
        invoiceCents + frozen.request.fixedFeeBreakdown.residentAddedFeeCents ||
      frozen.request.metadata?.source_arbitration_v !== "1") {
    return { ok: false, status: 409, error: "Invoice provider terms need reconciliation." };
  }
  const result = await createAxisAchCheckoutSession(stripe, frozen.request);
  if (result.mode !== "embedded" || !result.clientSecret) {
    return { ok: false, status: 500, error: "Could not start invoice checkout." };
  }
  const stored = await db.from("vendor_invoices")
    .update({ checkout_session_id: result.sessionId, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("manager_user_id", opts.managerUserId)
    .eq("payment_claim", "stripe").eq("checkout_session_id", attempt)
    .select("id").maybeSingle();
  if (stored.error || !stored.data) {
    return { ok: false, status: 503, error: "Payment status is being reconciled. Try again shortly." };
  }
  return {
    ok: true,
    clientSecret: result.clientSecret,
    sessionId: result.sessionId,
    invoiceCents,
    platformFeeCents: frozenFeeCents,
    processingFeeCents: result.processingFeeCents,
    totalCents: result.totalCents,
  };
}

/**
 * The session never got paid (expired, or the bank debit bounced): hand its claim back so the
 * invoice is payable again. One rule for the Stripe rail: the session id is compared in the
 * database and Stripe's live state must be terminal first (`releaseFailedVendorInvoiceCheckout`).
 */
export async function releaseVendorInvoiceDirectPayClaim(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<void> {
  await releaseFailedVendorInvoiceCheckout(db, session);
}

/**
 * Settles a direct invoice-pay Checkout session.
 *
 * A session that HOLDS the claim it took before charging owns every write below, so a retry after
 * a failed one must redo them — gating on the invoice's own status alone meant the invoice flipped
 * to `paid`, a later write threw, and the redelivery then skipped the payout row and the vendor's
 * ledger credit entirely. An unclaimed (standalone) invoice writes its payout BEFORE it is marked
 * paid for the same reason; the status gate then only ever skips work that is genuinely done.
 */
export async function completeVendorInvoicePaymentFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.metadata?.purpose !== VENDOR_INVOICE_DIRECT_PAY_PURPOSE) return;
  const invoiceId = session.metadata.invoice_id?.trim();
  const managerUserId = session.metadata.manager_user_id?.trim();
  const vendorUserId = session.metadata.vendor_user_id?.trim();
  if (!invoiceId || !managerUserId || !vendorUserId) return;

  if (session.payment_status !== "paid") return;

  const isHold = session.metadata.platform_hold === "1";
  const platformFeeCents = Number(session.metadata.platform_fee_cents ?? 0);

  const { data: existing, error: lookupError } = await db.from("vendor_invoices")
    .select("status, payment_claim, checkout_session_id, stripe_checkout_provider_terms, manager_user_id, vendor_user_id, total_cents")
    .eq("id", invoiceId).eq("manager_user_id", managerUserId).maybeSingle();
  if (lookupError || !existing || existing.payment_claim !== "stripe" || existing.checkout_session_id !== session.id) {
    // A session created before claim tracking needs manual reconciliation. A
    // stale session must never mark a newer balance/offline payment paid.
    throw new Error("Invoice checkout has no matching Stripe payment claim.");
  }
  const invoiceCents = Math.round(Number(existing.total_cents));
  const processingFeeCents = Number(session.metadata.processing_fee_cents);
  if (existing.manager_user_id !== managerUserId || existing.vendor_user_id !== vendorUserId ||
      !Number.isSafeInteger(invoiceCents) || invoiceCents < 100 ||
      Number(session.metadata.invoice_cents) !== invoiceCents ||
      !Number.isSafeInteger(processingFeeCents) || processingFeeCents < 0 ||
      !Number.isSafeInteger(platformFeeCents) || platformFeeCents < 0 ||
      platformFeeCents >= invoiceCents ||
      session.currency?.toLowerCase() !== "usd" ||
      session.amount_total !== invoiceCents + processingFeeCents ||
      (session.metadata.payment_method !== "card" && session.metadata.payment_method !== "ach")) {
    throw new Error("Invoice checkout amount or owner differs from the approved invoice.");
  }
  const stripe = getStripe();
  let verifiedHoldId: string | null = null;
  let stripeChargeId: string | null;
  if (session.metadata.source_arbitration_v === "1") {
    const frozen = existing.stripe_checkout_provider_terms as {
      invoiceId?: string; managerUserId?: string; vendorUserId?: string;
      invoiceCents?: number; request?: { idempotencyKey?: string;
        destinationAccountId?: string | null; paymentMethod?: string;
        metadata?: Record<string, string>; extraApplicationFeeCents?: number;
        fixedFeeBreakdown?: { residentAddedFeeCents: number; totalCents: number } };
    } | null;
    if (!frozen?.request || frozen.invoiceId !== invoiceId ||
        frozen.managerUserId !== managerUserId || frozen.vendorUserId !== vendorUserId ||
        frozen.invoiceCents !== invoiceCents ||
        frozen.request.destinationAccountId ||
        frozen.request.paymentMethod !== session.metadata.payment_method ||
        frozen.request.extraApplicationFeeCents !== platformFeeCents ||
        frozen.request.fixedFeeBreakdown?.residentAddedFeeCents !== processingFeeCents ||
        frozen.request.fixedFeeBreakdown?.totalCents !== session.amount_total ||
        frozen.request.metadata?.source_arbitration_v !== "1" ||
        frozen.request.metadata?.platform_fee_cents !== String(platformFeeCents) ||
        frozen.request.idempotencyKey !==
          `vendor-invoice:${invoiceId}:${session.metadata.checkout_attempt}`) {
      throw new Error("Invoice Checkout differs from its frozen provider claim.");
    }
    const source = await creditVerifiedVendorCheckoutSource(db, stripe, session, {
      purpose: VENDOR_INVOICE_DIRECT_PAY_PURPOSE,
      managerUserId, vendorUserId, sourceId: directInvoiceHoldSourceId(invoiceId),
      componentId: invoiceId, componentKind: "vendor_invoice",
      principalCents: invoiceCents, platformFeeCents,
    });
    verifiedHoldId = source.holdId;
    stripeChargeId = source.chargeId;
  } else {
    if (session.metadata.source_arbitration_v) {
      throw new Error("Unknown invoice source arbitration version.");
    }
    const legacy = await verifyLegacyVendorCheckoutSource(db, stripe, session, {
      purpose: VENDOR_INVOICE_DIRECT_PAY_PURPOSE,
      managerUserId, vendorUserId, principalCents: invoiceCents,
      platformFeeCents, sourceId: directInvoiceHoldSourceId(invoiceId),
    });
    stripeChargeId = legacy.chargeId;
  }
  if (!verifiedHoldId) await creditHoldFromPaidSession(db, session, stripeChargeId);
  await settleInvoicePayment(db, managerUserId, invoiceId, "stripe");
  if (isHold && !stripeChargeId) throw new Error("Paid invoice Checkout has no resolvable Stripe charge.");

  await upsertInvoiceVendorPayout(db, {
      invoiceId,
      managerUserId,
      vendorUserId,
      amountCents: invoiceCents,
      stripeTransferId: isHold ? null : session.id,
      platformFeeCents,
      destination: isHold ? "hold" : "destination_charge",
      stripeChargeId,
      platformHoldId: verifiedHoldId,
  });

  if (platformFeeCents > 0) {
      await recordVendorBankingChargeAndFee(db, {
        vendorUserId,
        managerUserId,
        grossCents: invoiceCents,
        feeCents: platformFeeCents,
        source: "invoice",
        sourceId: invoiceId,
        description: "Payment for invoice",
        stripeObjectId: stripeChargeId ?? session.id,
      });
      // PropLane's own revenue, written through beside the vendor statement fee line. Never throws.
      await recordVendorServiceFeeRevenue(db, {
        vendorUserId,
        managerUserId,
        feeCents: platformFeeCents,
        source: "invoice",
        sourceId: invoiceId,
      });
  }
  if (verifiedHoldId) await releaseVerifiedPlatformHoldsForOwner(db, {
    ownerUserId: vendorUserId, holdId: verifiedHoldId, stripe,
  });
}

/** Release only a terminal failed/expired Stripe attempt. Webhooks and retries
 * both pass through the same session-id compare-and-swap database function. */
export async function releaseFailedVendorInvoiceCheckout(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.metadata?.purpose !== VENDOR_INVOICE_DIRECT_PAY_PURPOSE) return;
  const invoiceId = session.metadata.invoice_id?.trim();
  const managerUserId = session.metadata.manager_user_id?.trim();
  if (!invoiceId || !managerUserId) return;
  const stripe = getStripe();
  const current = await stripe.checkout.sessions.retrieve(session.id);
  let terminal = current.status === "expired";
  if (!terminal && current.status === "complete" && current.payment_status === "unpaid" && current.payment_intent) {
    const intent = typeof current.payment_intent === "string"
      ? await stripe.paymentIntents.retrieve(current.payment_intent)
      : current.payment_intent;
    terminal = intent.status === "requires_payment_method" || intent.status === "canceled";
  }
  if (!terminal) return;
  const { error } = await db.rpc("release_vendor_invoice_stripe_checkout", {
    p_invoice: invoiceId,
    p_manager: managerUserId,
    p_session: session.id,
  });
  if (error) throw new Error(error.message);
}

async function upsertInvoiceVendorPayout(
  db: SupabaseClient,
  opts: {
    invoiceId: string;
    managerUserId: string;
    vendorUserId: string;
    amountCents: number;
    stripeTransferId: string | null;
    platformFeeCents: number;
    destination: "destination_charge" | "hold";
    stripeChargeId: string | null;
    platformHoldId: string | null;
  },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: existing, error: readError } = await db.from("vendor_payouts")
    .select("id,manager_user_id,vendor_user_id,amount_cents,status,stripe_transfer_id,platform_fee_cents,destination,stripe_charge_id,platform_hold_id")
    .eq("invoice_id", opts.invoiceId).maybeSingle();
  if (readError) throw new Error(`Could not read invoice payout: ${readError.message}`);
  const patch = {
    manager_user_id: opts.managerUserId,
    vendor_user_id: opts.vendorUserId,
    invoice_id: opts.invoiceId,
    amount_cents: opts.amountCents,
    status: "paid",
    stripe_transfer_id: opts.stripeTransferId,
    platform_fee_cents: opts.platformFeeCents,
    destination: opts.destination,
    stripe_charge_id: opts.stripeChargeId,
    platform_hold_id: opts.platformHoldId,
    updated_at: nowIso,
  };
  if (existing?.id) {
    const metadataUninitialized = !existing.destination && !existing.stripe_charge_id;
    if (existing.manager_user_id !== opts.managerUserId || existing.vendor_user_id !== opts.vendorUserId ||
        Number(existing.amount_cents) !== opts.amountCents ||
        !["pending", "paid", "partially_refunded", "refunded"].includes(String(existing.status)) ||
        (existing.stripe_transfer_id && opts.stripeTransferId && existing.stripe_transfer_id !== opts.stripeTransferId) ||
        (existing.stripe_charge_id && opts.stripeChargeId && existing.stripe_charge_id !== opts.stripeChargeId) ||
        (existing.platform_hold_id && opts.platformHoldId && existing.platform_hold_id !== opts.platformHoldId) ||
        (existing.status !== "pending" && !metadataUninitialized && Number(existing.platform_fee_cents) !== opts.platformFeeCents) ||
        (existing.destination && existing.destination !== opts.destination)) {
      throw new Error("Invoice payout terms no longer match the paid session.");
    }
    const { data: updated, error } = await db.from("vendor_payouts").update({
      ...((existing.status === "pending" || metadataUninitialized) ? { platform_fee_cents: opts.platformFeeCents } : {}),
      ...(existing.status === "pending" ? { status: "paid" } : {}),
      ...(!existing.stripe_transfer_id && opts.stripeTransferId ? { stripe_transfer_id: opts.stripeTransferId } : {}),
      ...(!existing.stripe_charge_id && opts.stripeChargeId ? { stripe_charge_id: opts.stripeChargeId } : {}),
      ...(!existing.platform_hold_id && opts.platformHoldId ? { platform_hold_id: opts.platformHoldId } : {}),
      ...(!existing.destination ? { destination: opts.destination } : {}),
      updated_at: nowIso,
    }).eq("id", existing.id)
      .eq("manager_user_id", opts.managerUserId).eq("vendor_user_id", opts.vendorUserId)
      .eq("amount_cents", opts.amountCents).eq("status", existing.status)
      .select("id").maybeSingle();
    if (error || !updated?.id) throw new Error(`Could not repair invoice payout: ${error?.message ?? "row changed"}`);
  } else {
    const { error } = await db.from("vendor_payouts").insert({ ...patch, created_at: nowIso });
    if (error) throw new Error(error.message);
  }
}

async function resolveChargeIdFromCheckoutSession(stripe: Stripe, session: Stripe.Checkout.Session): Promise<string | null> {
  const pi = session.payment_intent;
  if (!pi) return null;
  const intent = typeof pi === "string" ? await stripe.paymentIntents.retrieve(pi) : pi;
  const charge = intent.latest_charge;
  return typeof charge === "string" ? charge : charge?.id ?? null;
}
