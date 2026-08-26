import { headers } from "next/headers";
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { track } from "@/lib/analytics/posthog";
import { getStripe } from "@/lib/stripe";
import {
  applyScheduledDowngradeAfterInvoicePaid,
  reconcileManagerPurchaseByStripeSubscriptionId,
  reconcileManagerPurchaseWithStripe,
} from "@/lib/manager-stripe-subscription-sync";
import { recordPaidManagerCheckoutSession } from "@/lib/manager-purchase-from-session";
import { recordAutoExpense } from "@/lib/reports/auto-expense";
import {
  inferPaidTierFromStripePriceId,
  inferBillingFromStripePriceId,
} from "@/lib/stripe-price-ids";
import {
  stripeInvoiceLinePriceId,
  stripeInvoiceSubscriptionId,
} from "@/lib/stripe-subscription-helpers";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { reconcileManagerSmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
import {
  markApplicationDepositPaidFromStripeSession,
  markApplicationFeePaidFromStripeSession,
} from "@/lib/stripe-application-fee";
import {
  householdChargeCheckoutProcessing,
  markHouseholdChargePaidFromStripeSession,
  markHouseholdChargeProcessingFromStripeSession,
  revertHouseholdChargeProcessingFromStripeSession,
} from "@/lib/stripe-household-charge";
import { runScreeningFromStripeSession, SCREENING_CHECKOUT_PURPOSE } from "@/lib/stripe-screening";
import { enrichLedgerFromCheckoutSession } from "@/lib/stripe-ledger-fees";
import {
  handleConnectPayoutEvent,
  handlePaymentIntentFailed,
  handleStripeAccountUpdated,
  handleStripeDisputeEvent,
  handleStripeRefund,
  handleStripeTransferCreated,
  handleStripeTransferReversed,
} from "@/lib/stripe-webhook-financials";

export const runtime = "nodejs";

function logCheckoutCompleted(session: Stripe.Checkout.Session) {
  const customer = session.customer;
  const subscription = session.subscription;

  const customerId = typeof customer === "string" ? customer : customer?.id ?? null;
  const subscriptionId = typeof subscription === "string" ? subscription : subscription?.id ?? null;

  const tier = session.metadata?.tier ?? null;
  const billing = session.metadata?.billing ?? null;
  const userId = session.metadata?.userId ?? null;

  console.info("[stripe webhook] checkout.session.completed", {
    sessionId: session.id,
    customerId,
    subscriptionId,
    tier,
    billing,
    userId,
  });
}

async function enrichCheckoutLedgerFees(stripe: Stripe, session: Stripe.Checkout.Session): Promise<void> {
  const purpose = session.metadata?.purpose;
  if (purpose !== "household_charge" && purpose !== "rental_application_fee") return;
  const db = createSupabaseServiceRoleClient();
  await enrichLedgerFromCheckoutSession(db, stripe, session).catch((e) => {
    console.error("[stripe webhook] ledger fee enrichment", e);
  });
}

/**
 * Auto-records a manager subscription invoice payment as a business expense.
 * Only for renewal/change invoices (`billing_reason !== "subscription_create"`)
 * — the first invoice of a new subscription is recorded from
 * `checkout.session.completed` instead, since `manager_purchases` may not yet
 * have `stripe_subscription_id` populated when that first `invoice.paid`
 * event races the checkout-completed webhook.
 */
async function recordSubscriptionInvoiceExpense(inv: Stripe.Invoice, subscriptionId: string): Promise<void> {
  const db = createSupabaseServiceRoleClient();
  const { data: purchase } = await db
    .from("manager_purchases")
    .select("user_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  const managerUserId = purchase?.user_id ? String(purchase.user_id) : "";
  if (!managerUserId) return;

  const priceId = stripeInvoiceLinePriceId(inv);
  const tier = inferPaidTierFromStripePriceId(priceId);
  const billing = inferBillingFromStripePriceId(priceId);
  const planLabel = tier ? `${tier}${billing ? ` (${billing})` : ""}` : "subscription";

  await recordAutoExpense(db, managerUserId, {
    categoryCode: "management",
    amountCents: inv.amount_paid,
    expenseDate: new Date(inv.created * 1000).toISOString().slice(0, 10),
    memo: `PropLane platform subscription — ${planLabel}`,
    sourceStripePaymentId: inv.id,
  });
}

/** Auto-records the first subscription payment (from Checkout) as a business expense. */
async function recordCheckoutSubscriptionExpense(session: Stripe.Checkout.Session): Promise<void> {
  const uid = session.metadata?.userId?.trim();
  const amountCents = session.amount_total ?? 0;
  if (!uid || amountCents <= 0) return;

  const tier = session.metadata?.tier?.trim();
  const billing = session.metadata?.billing?.trim();
  const planLabel = tier ? `${tier}${billing ? ` (${billing})` : ""}` : "subscription";

  const db = createSupabaseServiceRoleClient();
  await recordAutoExpense(db, uid, {
    categoryCode: "management",
    amountCents,
    expenseDate: new Date().toISOString().slice(0, 10),
    memo: `PropLane platform subscription — ${planLabel}`,
    sourceStripePaymentId: session.id,
  });
}

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, { status: 500 });
  }

  const body = await req.text();
  const signature = (await headers()).get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const db = createSupabaseServiceRoleClient();

  try {
    if (event.type === "account.updated") {
      const account = event.data.object as Stripe.Account;
      await handleStripeAccountUpdated(db, account).catch((e) => {
        console.error("[stripe webhook] account.updated", e);
      });
    }

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object as Stripe.Checkout.Session;
      logCheckoutCompleted(session);
      if (session.metadata?.purpose === "rental_application_fee") {
        try {
          await markApplicationFeePaidFromStripeSession(db, session);
          // No-op on any session that did not combine a holding deposit
          // (`metadata.includes_holding_deposit` — legacy-only; nothing
          // creates combined fee+deposit sessions anymore).
          await markApplicationDepositPaidFromStripeSession(db, session);
          await enrichCheckoutLedgerFees(stripe, session);
          const distinctId = session.client_reference_id ?? session.id;
          track("application_fee_paid", distinctId, { session_id: session.id });
        } catch (e) {
          console.error("[stripe webhook] rental_application_fee checkout", e);
        }
      } else if (session.metadata?.purpose === SCREENING_CHECKOUT_PURPOSE) {
        // No catch: an unexpected throw returns 500 so Stripe retries; the
        // order placement is idempotent on the session id.
        await runScreeningFromStripeSession(db, session);
      } else if (session.metadata?.purpose === "household_charge") {
        try {
          if (householdChargeCheckoutProcessing(session)) {
            // ACH submitted, clearing for 3–5 business days: hold the charges
            // in `processing` so late fees / reminders / re-pay stay quiet.
            await markHouseholdChargeProcessingFromStripeSession(db, session);
          } else {
            await markHouseholdChargePaidFromStripeSession(db, session);
            await enrichCheckoutLedgerFees(stripe, session);
            const distinctId = session.client_reference_id ?? session.id;
            track("household_charge_paid", distinctId, { session_id: session.id });
          }
        } catch (e) {
          console.error("[stripe webhook] household_charge checkout", e);
        }
      } else {
        try {
          await recordPaidManagerCheckoutSession(session);
          const uid = session.metadata?.userId?.trim();
          if (uid) {
            const tier = session.metadata?.tier ?? "";
            const billing = session.metadata?.billing ?? "";
            const subscriptionId =
              typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? "";
            track("manager_subscription_purchased", uid, { tier, billing, subscription_id: subscriptionId });
            try {
              await reconcileManagerPurchaseWithStripe(uid);
            } catch (reconcileErr) {
              console.error("[stripe webhook] reconcileManagerPurchaseWithStripe", reconcileErr);
            }
            try {
              await recordCheckoutSubscriptionExpense(session);
            } catch (expenseErr) {
              console.error("[stripe webhook] recordCheckoutSubscriptionExpense", expenseErr);
            }
          }
        } catch (e) {
          console.error("[stripe webhook] recordPaidManagerCheckoutSession", e);
        }
      }
    }

    if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object as Stripe.Checkout.Session;
      // The bank debit bounced: release the clearing-window hold so the charge
      // is payable again. NSF fee + `failed` status come from the
      // payment_intent.payment_failed handler below, never from here.
      await revertHouseholdChargeProcessingFromStripeSession(db, session).catch((e) => {
        console.error("[stripe webhook] async_payment_failed household_charge", e);
      });
    }

    if (event.type === "invoice.paid") {
      const inv = event.data.object as Stripe.Invoice;
      const subId = stripeInvoiceSubscriptionId(inv);
      if (subId) {
        try {
          await applyScheduledDowngradeAfterInvoicePaid(subId, inv.billing_reason ?? null);
        } catch (e) {
          console.error("[stripe webhook] invoice.paid scheduled downgrade", e);
        }
        if (inv.billing_reason !== "subscription_create" && inv.amount_paid > 0) {
          try {
            await recordSubscriptionInvoiceExpense(inv, subId);
          } catch (e) {
            console.error("[stripe webhook] invoice.paid auto-expense", e);
          }
        }
        const { data: smsPurchase } = await db
          .from("manager_purchases")
          .select("user_id")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();
        const smsManagerId = String(smsPurchase?.user_id ?? "").trim();
        if (smsManagerId) {
          const smsEntitlement = await reconcileManagerSmsEntitlement(db, smsManagerId);
          if (!smsEntitlement.eligible && smsEntitlement.reason === "plan_unreadable") {
            throw new Error("SMS entitlement reconciliation failed after invoice payment.");
          }
        }
      }
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const { data: smsPurchase } = await db
        .from("manager_purchases")
        .select("user_id")
        .eq("stripe_subscription_id", sub.id)
        .maybeSingle();
      const smsManagerId = String(smsPurchase?.user_id ?? "").trim();
      try {
        if (event.type === "customer.subscription.deleted") {
          await db
            .from("manager_purchases")
            .update({ tier: "free", billing: "free", stripe_subscription_id: null })
            .eq("stripe_subscription_id", sub.id);
        } else {
          await reconcileManagerPurchaseByStripeSubscriptionId(sub.id);
        }
      } catch (e) {
        console.error("[stripe webhook] subscription event", e);
      }
      if (smsManagerId) {
        const smsEntitlement = await reconcileManagerSmsEntitlement(db, smsManagerId, {
          loadStripeSubscription: async () => sub,
        });
        if (!smsEntitlement.eligible && smsEntitlement.reason === "plan_unreadable") {
          throw new Error("SMS entitlement reconciliation failed after subscription event.");
        }
      }
    }

    if (event.type === "transfer.created") {
      await handleStripeTransferCreated(db, event.data.object as Stripe.Transfer).catch((e) => {
        console.error("[stripe webhook] transfer.created", e);
      });
    }

    if (event.type === "transfer.reversed") {
      await handleStripeTransferReversed(db, event.data.object as Stripe.Transfer).catch((e) => {
        console.error("[stripe webhook] transfer.reversed", e);
      });
    }

    if (
      event.type === "payout.created" ||
      event.type === "payout.updated" ||
      event.type === "payout.paid" ||
      event.type === "payout.failed" ||
      event.type === "payout.canceled"
    ) {
      await handleConnectPayoutEvent(db, event.data.object as Stripe.Payout, event.account).catch((e) => {
        console.error("[stripe webhook] payout event", e);
      });
    }

    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const refunds = charge.refunds?.data ?? [];
      for (const refund of refunds) {
        if (refund.status === "succeeded" || refund.status === "pending") {
          await handleStripeRefund(db, refund, charge.id).catch((e) => {
            console.error("[stripe webhook] charge.refunded", e);
          });
        }
      }
    }

    if (event.type === "refund.created" || event.type === "refund.updated") {
      const refund = event.data.object as Stripe.Refund;
      if (refund.status === "succeeded") {
        const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
        if (chargeId) {
          await handleStripeRefund(db, refund, chargeId).catch((e) => {
            console.error("[stripe webhook] refund event", e);
          });
        }
      }
    }

    if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed" || event.type === "charge.dispute.updated") {
      await handleStripeDisputeEvent(db, event.data.object as Stripe.Dispute).catch((e) => {
        console.error("[stripe webhook] dispute event", e);
      });
    }

    if (event.type === "payment_intent.payment_failed") {
      await handlePaymentIntentFailed(db, event.data.object as Stripe.PaymentIntent).catch((e) => {
        console.error("[stripe webhook] payment_intent.payment_failed", e);
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Webhook handler error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
