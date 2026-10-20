import "server-only";

/**
 * The resident bank (ACH) payment status read and microdeposit verification, shared by the signed-in route
 * (`/api/stripe/resident-ach-payment`, actor = the resident's session) and the phone-bound link's route
 * (`/api/l/<token>/bank-payment`, actor = the resident the verified link names). The ACTOR is always passed in:
 * the original-actor check on the attempt happens here, before any provider verification or receipt mutation.
 */
import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { loadResidentManualAchAttemptForPaymentIntent } from "@/lib/resident-checkout-claim.server";
import { reconcileResidentManualAchPaymentIntent } from "@/lib/stripe-household-charge";
import { creditVerifiedHouseholdManualSource } from "@/lib/household-captured-source.server";
import { recordHouseholdSourceReviewNeeded } from "@/lib/household-source-review.server";
import { assertTestWorkspaceProviderEffectAllowed, TestWorkspaceProviderDisabledError } from "@/lib/test-workspaces/effects.server";

function bankState(status: string, nextAction: string | undefined) {
  if (status === "requires_action" && nextAction === "verify_with_microdeposits") return "verification";
  if (status === "processing") return "clearing";
  if (status === "succeeded") return "paid";
  if (status === "requires_payment_method" || status === "requires_confirmation") return "entry";
  return "review";
}

export async function answerResidentAchPayment(paymentIntentId: string, userId: string) {
  const stripe = getStripe();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const db = createSupabaseServiceRoleClient();
  // Exact original actor is checked before any provider verification attempt
  // or local receipt mutation. A reused email cannot own a detached attempt.
  const attempt = await loadResidentManualAchAttemptForPaymentIntent(db, paymentIntent, userId);
  const state = bankState(paymentIntent.status, paymentIntent.next_action?.type);
  const clientFields = { paymentIntentId: paymentIntent.id, clientSecret: paymentIntent.client_secret,
    chargeIds: attempt.charge_ids, subtotalCents: attempt.subtotal_cents,
    processingFeeCents: attempt.payer_total_cents - attempt.subtotal_cents,
    axisFeeCents: 0, totalCents: attempt.payer_total_cents };
  if (state === "entry" || state === "review") {
    return NextResponse.json({ paid: false, processing: false, bankStatus: state,
      ...clientFields });
  }
  const settled = await reconcileResidentManualAchPaymentIntent(db, paymentIntent, userId);
  if (!settled.ok) return NextResponse.json({ paid: false, processing: false,
    bankStatus: "review", error: "Bank payment needs review." }, { status: 409 });
  let sourceReview = false;
  if (settled.paid) {
    try {
      await creditVerifiedHouseholdManualSource(db, stripe, paymentIntent);
    } catch (e) {
      // The charge rows are already paid by the reconcile above. Crediting the manager's
      // hold is platform accounting — idempotent, and retried by the webhook — so a refusal
      // there is reported, never turned into "your completed payment did not go through".
      // The reason is filed against the manager (one row per source, admin Health) and
      // logged with its stack here, so a missing hold is findable either way.
      console.error("[resident ach verify] credit verified source", e);
      await recordHouseholdSourceReviewNeeded(db, {
        ownerManagerUserId: paymentIntent.metadata?.manager_user_id,
        sourceId: paymentIntent.id,
        paymentIntentId: paymentIntent.id,
        chargeIds: attempt.charge_ids,
        surface: "manual_ach_verify",
        error: e,
      });
      sourceReview = true;
    }
  }
  return NextResponse.json({ paid: settled.paid, processing: settled.processing,
    bankStatus: state, chargeId: settled.chargeId,
    ...(sourceReview ? { sourceReview: true } : {}), ...clientFields });
}


export async function residentAchStatusResponse(id: string | undefined, userId: string): Promise<NextResponse> {
  if (!id) return NextResponse.json({ error: "Missing payment_intent_id." }, { status: 400 });
  try {
    return await answerResidentAchPayment(id, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("does not belong")) {
      return NextResponse.json({ error: "Bank payment is not yours." }, { status: 403 });
    }
    return NextResponse.json({ paid: false, processing: false,
      bankStatus: "review", error: "Bank payment needs review." }, { status: 409 });
  }
}

export async function residentAchVerifyResponse(req: Request, userId: string): Promise<NextResponse> {
  const body = await req.json().catch(() => null) as
    { paymentIntentId?: unknown; descriptorCode?: unknown; amounts?: unknown } | null;
  const id = typeof body?.paymentIntentId === "string" ? body.paymentIntentId.trim() : "";
  const code = typeof body?.descriptorCode === "string" ? body.descriptorCode.trim().toUpperCase() : "";
  const amounts = body?.amounts;
  const validAmounts = Array.isArray(amounts) && amounts.length === 2 &&
    amounts.every(value => Number.isSafeInteger(value) && value > 0 && value < 100);
  if (!id || (Boolean(code) === validAmounts) ||
      (code && !/^SM[A-Z0-9]{4}$/.test(code))) {
    return NextResponse.json({ error: "Enter the bank verification code or two deposit amounts." },
      { status: 400 });
  }
  try {
    const db = createSupabaseServiceRoleClient();
    // Role (above) and the test-workspace effect gate both precede every
    // provider call, including the read that proves the original actor.
    await assertTestWorkspaceProviderEffectAllowed({ userId, kind: "payment",
      summary: "Bank microdeposit verification refused for a test workspace.", db });
    const stripe = getStripe();
    const before = await stripe.paymentIntents.retrieve(id);
    await loadResidentManualAchAttemptForPaymentIntent(db, before, userId);
    if (before.status !== "requires_action" ||
        before.next_action?.type !== "verify_with_microdeposits") {
      return NextResponse.json({ error: "This bank payment is not awaiting verification." }, { status: 409 });
    }
    await stripe.paymentIntents.verifyMicrodeposits(id,
      code ? { descriptor_code: code } : { amounts: amounts as number[] });
    return await answerResidentAchPayment(id, userId);
  } catch (error) {
    if (error instanceof TestWorkspaceProviderDisabledError) {
      return NextResponse.json({ error: "Payments are unavailable for test accounts." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("does not belong")) {
      return NextResponse.json({ error: "Bank payment is not yours." }, { status: 403 });
    }
    return NextResponse.json({ error: "Bank verification could not be completed. Check the deposits and try again." },
      { status: 409 });
  }
}
