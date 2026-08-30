/**
 * Places the Checkr screening order after the manager's Stripe Checkout
 * payment clears. This is the ONLY live path that starts a paid background
 * check — the checkout route never orders, it just collects payment.
 *
 * Idempotent: `runBackgroundCheck` short-circuits when the application's
 * check already carries this Checkout session id, so Stripe webhook retries
 * and duplicate deliveries never double-order.
 */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { runBackgroundCheck, runCosignerBackgroundCheck } from "@/lib/checkr/background-check";
import { getStripe } from "@/lib/stripe";

export const SCREENING_CHECKOUT_PURPOSE = "application_screening";

export function isScreeningCheckoutSession(session: Stripe.Checkout.Session): boolean {
  return session.metadata?.purpose === SCREENING_CHECKOUT_PURPOSE;
}

export async function runScreeningFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (!isScreeningCheckoutSession(session)) return;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return;

  const applicationId = session.metadata?.application_id?.trim();
  const cosignerSubmissionId = session.metadata?.cosigner_submission_id?.trim();
  const managerUserId = session.metadata?.manager_user_id?.trim();
  if (!applicationId || !managerUserId) {
    console.error("[stripe webhook] screening checkout missing metadata", { sessionId: session.id });
    return;
  }
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;

  const result = cosignerSubmissionId
    ? await runCosignerBackgroundCheck({
        db,
        cosignerSubmissionId,
        managerUserId,
        packageSlug: session.metadata?.package_slug,
        addOnProducts: (session.metadata?.add_on_products ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        prepaid: { checkoutSessionId: session.id, paymentIntentId },
      })
    : await runBackgroundCheck({
        db,
        applicationId,
        managerUserId,
        packageSlug: session.metadata?.package_slug,
        addOnProducts: (session.metadata?.add_on_products ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        prepaid: { checkoutSessionId: session.id, paymentIntentId },
      });

  if (result.ok) {
    track("background_check_started", managerUserId, { provider: result.backgroundCheck.provider });
    if (result.backgroundCheck.status === "complete" && result.backgroundCheck.result) {
      track("background_check_completed", managerUserId, {
        provider: result.backgroundCheck.provider,
        result: result.backgroundCheck.result,
      });
    }
    return;
  }

  // Payment was taken but the order can never be placed (application deleted,
  // another check went pending in the meantime, plan downgraded, …). Checkr
  // provider errors already refunded inside runBackgroundCheck — refund the
  // remaining permanent failures here so the manager isn't charged for nothing.
  console.error("[stripe webhook] screening order failed after payment", {
    sessionId: session.id,
    applicationId,
    status: result.status,
    code: result.code,
    error: result.error,
  });
  if (paymentIntentId && result.code !== "provider_error") {
    try {
      const stripe = getStripe();
      await stripe.refunds.create({ payment_intent: paymentIntentId, reason: "requested_by_customer" });
    } catch (refundError) {
      console.error("[stripe webhook] screening charge not refunded after order failure", {
        sessionId: session.id,
        applicationId,
        paymentIntentId,
        refundError: refundError instanceof Error ? refundError.message : String(refundError),
      });
    }
  }
}
