import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { createAxisAchCheckoutSession } from "@/lib/stripe-axis-ach-checkout";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import { creditHoldFromPaidSession } from "@/lib/stripe-platform-hold.server";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { vendorPayFeeCents } from "@/lib/platform-fees";
import { recordVendorBankingChargeAndFee } from "@/lib/vendor-banking/ledger.server";
import {
  assertNoCrossRailPayout,
  claimInvoicePayment,
  settleInvoicePayment,
} from "@/lib/vendor-invoice-settlement.server";
import { readInvoicePaymentClaimId, releaseInvoicePaymentClaim } from "@/lib/vendor-invoice-claim.server";
import { isVendorInvoicePaymentRefusal } from "@/lib/vendor-invoices";

export const VENDOR_INVOICE_DIRECT_PAY_PURPOSE = "vendor_invoice_direct_pay";

/**
 * How long an unpaid direct-pay session may hold the invoice's cross-rail claim. Stripe's floor
 * for `expires_at` is exactly 30 minutes out, so the half-minute is clock-skew headroom.
 */
const VENDOR_INVOICE_CHECKOUT_TTL_SECONDS = 30 * 60 + 30;

export type StartInvoicePayFailure = { ok: false; status: number; error: string };
export type StartInvoicePaySuccess = {
  ok: true;
  clientSecret: string;
  sessionId: string;
  invoiceCents: number;
  platformFeeCents: number;
};

/**
 * Manager pays an approved/scheduled vendor invoice in-app — "Request
 * payment" (VD48/49). Standalone vendor invoices (no work order) use this
 * path; work-order-linked settlement stays on `vendor-invoice-settlement.server.ts`.
 */
export async function startVendorInvoicePayCheckout(
  db: SupabaseClient,
  opts: { invoiceId: string; managerUserId: string; managerEmail: string },
): Promise<StartInvoicePaySuccess | StartInvoicePayFailure> {
  const { data: invoice, error } = await db
    .from("vendor_invoices")
    .select("id, manager_user_id, vendor_user_id, total_cents, status, invoice_number, memo, work_order_id, estimate_visit_bid_id")
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
    work_order_id: string | null;
    estimate_visit_bid_id: string | null;
  };
  if (row.status !== "approved" && row.status !== "scheduled") {
    return { ok: false, status: 409, error: `Invoice is ${row.status}; it must be approved before it can be paid.` };
  }
  const invoiceCents = Math.round(Number(row.total_cents) || 0);
  if (invoiceCents < 100) return { ok: false, status: 400, error: "Invoice total must be at least $1.00." };

  const platformFeeCents = vendorBankingEnabled() ? vendorPayFeeCents(invoiceCents) : 0;

  // A job invoice RESERVES the payout before the card is charged, using the same claim the
  // offline and balance rails take: while it is held, Approve + pay and the other invoice rails
  // are refused, by the database, not by a read-then-write race. Checking without claiming let a
  // manager open this checkout, run Approve + pay, and then complete the card payment — the second
  // charge went through and only its bookkeeping was refused.
  // A standalone invoice (no service) has no job for a second rail to pay, so there is nothing to
  // claim; `assertNoCrossRailPayout` is a no-op for it and for an estimate-visit fee.
  const claimsPayout = Boolean(row.work_order_id?.trim());
  let claimId: string | null = null;
  try {
    if (claimsPayout) {
      await claimInvoicePayment(db, opts.managerUserId, row.id, "stripe");
      claimId = await readInvoicePaymentClaimId(db, opts.managerUserId, row.id);
    } else await assertNoCrossRailPayout(db, row);
  } catch (e) {
    const message = e instanceof Error ? e.message : "This service has already been paid.";
    if (isVendorInvoicePaymentRefusal(e)) return { ok: false, status: 409, error: message };
    console.error("[vendor-invoice-pay] could not claim the invoice; no checkout was started", {
      invoiceId: row.id,
      managerUserId: opts.managerUserId,
      error: message,
    });
    return { ok: false, status: 500, error: message };
  }

  const releaseClaim = async (opts2: { checkoutSessionId?: string } = {}) => {
    if (!claimsPayout) return;
    await releaseInvoicePaymentClaim(db, opts.managerUserId, row.id, "stripe", opts2).catch((e) =>
      console.error("[vendor-invoice-pay] could not release the claim after a failed checkout start", e),
    );
  };

  // A claim with no row to point at cannot be tied to one session, and an untied claim is the
  // stranded kind: nothing would ever release it. Refuse now rather than open a checkout.
  if (claimsPayout && !claimId) {
    await releaseClaim();
    console.error("[vendor-invoice-pay] claimed the invoice but found no claim row", { invoiceId: row.id });
    return { ok: false, status: 500, error: "Could not reserve this invoice for payment; nothing was charged." };
  }

  // The short expiry exists to bound how long a CLAIM is held. A standalone invoice holds no
  // claim, so it keeps Stripe's own 24-hour default — the window its invoice-wide idempotency key
  // already matches, which is what stops a retry replaying a session that has died.
  const expiresAtUnix = claimsPayout ? Math.floor(Date.now() / 1000) + VENDOR_INVOICE_CHECKOUT_TTL_SECONDS : undefined;

  // Everything from here on can fail without a cent moving — Stripe refusing the session, a
  // Connect lookup timing out — and every one of those must hand the claim back, or an invoice
  // nobody paid stays unpayable by any rail until it expires.
  let result: Awaited<ReturnType<typeof createAxisAchCheckoutSession>>;
  let stripe: ReturnType<typeof getStripe>;
  try {
    stripe = getStripe();
    const destinationAccountId = await resolveConnectDestinationIfReady(stripe, db, row.vendor_user_id);
    const origin = resolveShareableAppOrigin();
    const label = row.invoice_number ? `Invoice ${row.invoice_number}` : row.memo?.trim() || "Vendor invoice";
    result = await createAxisAchCheckoutSession(stripe, {
      // Scoped to the CLAIM, not the invoice. Stripe keeps an idempotency key for 24 hours and
      // replays the first response, so an invoice-wide key outlived the 30-minute session it
      // created: after an abandon-and-retry it handed back the expired session's client secret,
      // the checkout died in the browser, and the fresh claim was never released — leaving the
      // invoice unpayable, unschedulable and undeletable by every rail. A re-submit of the SAME
      // claim still replays (one session per claim); a new claim gets a new session.
      idempotencyKey: `vendor-invoice:${row.id}:${claimId ?? "unclaimed"}`,
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
      },
      destinationAccountId: destinationAccountId ?? undefined,
      mode: "embedded",
      paymentMethod: "ach",
      feePayer: "resident",
      extraApplicationFeeCents: platformFeeCents,
      returnUrl: `${origin}/portal/finances?invoice_pay=success&session_id={CHECKOUT_SESSION_ID}`,
      expiresAtUnix,
    });
  } catch (e) {
    await releaseClaim();
    const message = e instanceof Error ? e.message : "Could not start invoice checkout.";
    console.error("[vendor-invoice-pay] Stripe would not open a checkout session", { invoiceId: row.id, error: message });
    return { ok: false, status: 500, error: message };
  }
  if (result.mode !== "embedded" || !result.clientSecret) {
    await releaseClaim();
    return { ok: false, status: 500, error: "Could not start invoice checkout." };
  }
  // Belt and braces behind the per-claim key. The body Stripe hands back can be a 24-hour
  // idempotency REPLAY of this claim's first request, so its status and expiry describe the
  // session as it was CREATED, not as it is now — a replay is exactly how a dead session reaches
  // this point, and also how a live one looks dead.
  const nowUnix = Math.floor(Date.now() / 1000);
  const replayLooksDead =
    result.status === "expired" ||
    result.status === "complete" ||
    (result.expiresAtUnix != null && result.expiresAtUnix <= nowUnix);
  if (replayLooksDead) {
    // Ask Stripe what the session IS before concluding anything. An ACH debit settles for days
    // with the session `complete` and the invoice still `approved`, and that claim is backing real
    // money: releasing it on a stale `expires_at` unblocked Approve + pay mid-debit and let the
    // vendor be paid twice. A lookup we cannot complete keeps the claim too — fail closed.
    let live: Stripe.Checkout.Session | null = null;
    try {
      live = await stripe.checkout.sessions.retrieve(result.sessionId);
    } catch {
      live = null;
    }
    const liveExpiresAt = live?.expires_at ?? null;
    const liveIsExpired =
      live?.status === "expired" || (live?.status === "open" && liveExpiresAt != null && liveExpiresAt <= Math.floor(Date.now() / 1000));
    if (liveIsExpired) {
      await releaseClaim({ checkoutSessionId: result.sessionId });
      console.error("[vendor-invoice-pay] the checkout session had expired; released the claim", {
        invoiceId: row.id,
        sessionId: result.sessionId,
      });
      return { ok: false, status: 500, error: "That payment window closed before it opened. Try again." };
    }
    if (!live || live.status === "complete") {
      console.error("[vendor-invoice-pay] a payment is already in flight for this invoice", {
        invoiceId: row.id,
        sessionId: result.sessionId,
        liveStatus: live?.status ?? null,
        livePaymentStatus: live?.payment_status ?? null,
      });
      return { ok: false, status: 409, error: "A payment for this invoice is already processing." };
    }
  }

  // Ties the claim to the session that holds it, so only THAT session's expiry or bounced debit
  // releases it — a replayed event for an abandoned attempt must not free a live payment's claim.
  if (claimsPayout) {
    const { data: tied } = await db
      .from("vendor_invoices")
      .update({ checkout_session_id: result.sessionId, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("manager_user_id", opts.managerUserId)
      .eq("payment_claim", "stripe")
      .select("id")
      .maybeSingle();
    if (!(tied as { id?: unknown } | null)?.id) {
      await releaseClaim();
      console.error("[vendor-invoice-pay] could not tie the claim to its checkout session", {
        invoiceId: row.id,
        sessionId: result.sessionId,
      });
      return { ok: false, status: 500, error: "Could not reserve this invoice for payment; nothing was charged." };
    }
  }

  return {
    ok: true,
    clientSecret: result.clientSecret,
    sessionId: result.sessionId,
    invoiceCents,
    platformFeeCents,
  };
}

/**
 * The session never got paid (expired, or the bank debit bounced): hand its cross-rail claim back
 * so the invoice is payable again. No money moved, so nothing is being undone.
 */
export async function releaseVendorInvoiceDirectPayClaim(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.metadata?.purpose !== VENDOR_INVOICE_DIRECT_PAY_PURPOSE) return;
  const invoiceId = session.metadata.invoice_id?.trim();
  const managerUserId = session.metadata.manager_user_id?.trim();
  if (!invoiceId || !managerUserId) return;
  await releaseInvoicePaymentClaim(db, managerUserId, invoiceId, "stripe", { checkoutSessionId: session.id });
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

  const invoiceCents = Number(session.metadata.invoice_cents ?? 0);
  const isHold = session.metadata.platform_hold === "1";
  const platformFeeCents = vendorBankingEnabled() ? Number(session.metadata.platform_fee_cents ?? 0) || 0 : 0;

  const { data: existing } = await db
    .from("vendor_invoices")
    .select("status, payment_claim")
    .eq("id", invoiceId)
    .maybeSingle();
  const invoiceRow = (existing ?? null) as { status?: string; payment_claim?: string | null } | null;
  const alreadyPaid = invoiceRow?.status === "paid";
  const holdsClaim = invoiceRow?.payment_claim === "stripe";

  // Converts the held claim into the settled payout: invoice paid, bill paid, expense entry, GL
  // posting and the claim's own `vendor_payouts` row flipped to paid — the same settle the offline
  // and balance rails run. Idempotent, so a redelivery repeats it harmlessly.
  if (holdsClaim) await settleInvoicePayment(db, managerUserId, invoiceId, "stripe");

  const stripeChargeId = vendorBankingEnabled()
    ? await resolveChargeIdFromCheckoutSession(getStripe(), session).catch(() => null)
    : null;
  await creditHoldFromPaidSession(db, session, stripeChargeId ?? undefined);

  if (!holdsClaim && alreadyPaid) return;

  await upsertInvoiceVendorPayout(db, {
    invoiceId,
    managerUserId,
    vendorUserId,
    amountCents: invoiceCents,
    stripeTransferId: isHold ? null : session.id,
    platformFeeCents,
    destination: isHold ? "hold" : "destination_charge",
    stripeChargeId,
  });

  if (vendorBankingEnabled()) {
    // Idempotent on `invoice:<id>:charge` / `:platform_fee`, so a redelivery credits nothing twice.
    await recordVendorBankingChargeAndFee(db, {
      vendorUserId,
      managerUserId,
      grossCents: invoiceCents,
      feeCents: platformFeeCents,
      source: "invoice",
      sourceId: invoiceId,
      description: "Payment for invoice",
      stripeObjectId: stripeChargeId ?? session.id,
    }).catch((e) => console.error("[vendor-banking] ledger write failed for invoice pay", e));
  }

  if (!holdsClaim) {
    const nowIso = new Date().toISOString();
    await db
      .from("vendor_invoices")
      .update({ status: "paid", paid_at: nowIso, paid_from: "stripe", updated_at: nowIso })
      .eq("id", invoiceId);
  }
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
  },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: existing } = await db.from("vendor_payouts").select("id").eq("invoice_id", opts.invoiceId).maybeSingle();
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
    updated_at: nowIso,
  };
  if (existing?.id) {
    const { error } = await db.from("vendor_payouts").update(patch).eq("id", existing.id);
    if (error) throw new Error(error.message);
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
