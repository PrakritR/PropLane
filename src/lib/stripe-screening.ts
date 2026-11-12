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
import type { CheckrPackage } from "@/lib/checkr/config";
import { isCheckrPackage } from "@/lib/checkr/packages";
import { fulfillPreApplyFromSession, isPreApplySession } from "@/lib/screening/preapply.server";
import { getStripe } from "@/lib/stripe";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";

export const SCREENING_CHECKOUT_PURPOSE = "application_screening";

export function isScreeningCheckoutSession(session: Stripe.Checkout.Session): boolean {
  return session.metadata?.purpose === SCREENING_CHECKOUT_PURPOSE;
}

/**
 * What a paid screening Checkout session says about HOW the order is placed. Everything here was written by our own
 * checkout routes (never by a client): an applicant-paid session names the applicant and carries their FCRA
 * authorization; an upgrade session names the package it replaces. The Stripe webhook and the checkout-verify
 * route both place the order from this, so they cannot disagree.
 */
export function screeningOrderOptionsFromSession(session: Stripe.Checkout.Session): {
  payer?: "applicant";
  authorization?: { authorizedAt: string; disclosureVersion: string };
  upgradeFrom?: CheckrPackage;
} {
  const applicantPaid = session.metadata?.payer === "applicant";
  const authorizedAt = session.metadata?.fcra_authorized_at?.trim();
  const disclosureVersion = session.metadata?.fcra_disclosure_version?.trim();
  const upgradeFromRaw = session.metadata?.upgrade_from_package?.trim() ?? "";
  return {
    ...(applicantPaid ? { payer: "applicant" as const } : {}),
    ...(applicantPaid && authorizedAt && disclosureVersion ? { authorization: { authorizedAt, disclosureVersion } } : {}),
    ...(isCheckrPackage(upgradeFromRaw) ? { upgradeFrom: upgradeFromRaw } : {}),
  };
}

export async function runScreeningFromStripeSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (!isScreeningCheckoutSession(session)) return;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return;

  // An applicant paying for the check their listing requires BEFORE applying: there is no application row yet.
  if (isPreApplySession(session)) {
    const placed = await fulfillPreApplyFromSession(db, session);
    const applicantUserId = session.metadata?.payer_user_id?.trim() || session.id;
    if (placed.ok && placed.check) {
      track("background_check_started", applicantUserId, { provider: placed.check.provider, phase: "preapply" });
    } else if (!placed.ok) {
      console.error("[stripe webhook] pre-apply screening order failed after payment", {
        sessionId: session.id,
        status: placed.status,
        code: placed.code,
        error: placed.error,
      });
    }
    return;
  }

  const applicationId = session.metadata?.application_id?.trim();
  const cosignerSubmissionId = session.metadata?.cosigner_submission_id?.trim();
  const managerUserId = session.metadata?.manager_user_id?.trim();
  if (!applicationId || !managerUserId) {
    console.error("[stripe webhook] screening checkout missing metadata", { sessionId: session.id });
    return;
  }
  const { data: application, error: ownerError } = await db
    .from("manager_application_records")
    .select("manager_user_id")
    .eq("id", applicationId)
    .maybeSingle();
  if (ownerError) throw new Error("Screening ownership could not be verified.");
  const storedManagerUserId = String(application?.manager_user_id ?? "").trim();
  if (!storedManagerUserId || storedManagerUserId !== managerUserId) {
    throw new Error("Screening ownership could not be verified.");
  }
  if ((await captureTestWorkspaceEffectForUser({
    userId: storedManagerUserId,
    kind: "payment",
    summary: "Screening fulfillment was refused for a test workspace.",
    metadata: { operation: "screening_fulfillment" },
    db,
  })).captured) return;
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;

  const orderOptions = screeningOrderOptionsFromSession(session);

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
        ...orderOptions,
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
