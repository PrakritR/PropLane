import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { loadResidentManualAchAttemptForPaymentIntent } from "@/lib/resident-checkout-claim.server";
import { reconcileResidentManualAchPaymentIntent } from "@/lib/stripe-household-charge";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { assertTestWorkspaceProviderEffectAllowed, TestWorkspaceProviderDisabledError } from "@/lib/test-workspaces/effects.server";

export const runtime = "nodejs";

async function actor() {
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user?.id) return { userId: null, forbidden: false };
  const db = createSupabaseServiceRoleClient();
  const { data: profile, error } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (error || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
    return { userId: null, forbidden: true };
  }
  return { userId: user.id, forbidden: false };
}

function bankState(status: string, nextAction: string | undefined) {
  if (status === "requires_action" && nextAction === "verify_with_microdeposits") return "verification";
  if (status === "processing") return "clearing";
  if (status === "succeeded") return "paid";
  if (status === "requires_payment_method" || status === "requires_confirmation") return "entry";
  return "review";
}

async function answer(paymentIntentId: string, userId: string) {
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
  return NextResponse.json({ paid: settled.paid, processing: settled.processing,
    bankStatus: state, chargeId: settled.chargeId, ...clientFields });
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("payment_intent_id")?.trim();
  if (!id) return NextResponse.json({ error: "Missing payment_intent_id." }, { status: 400 });
  const { userId, forbidden } = await actor();
  if (!userId) return NextResponse.json({ error: forbidden ? "Resident access required." : "Not authenticated." },
    { status: forbidden ? 403 : 401 });
  try {
    return await answer(id, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("does not belong")) {
      return NextResponse.json({ error: "Bank payment is not yours." }, { status: 403 });
    }
    return NextResponse.json({ paid: false, processing: false,
      bankStatus: "review", error: "Bank payment needs review." }, { status: 409 });
  }
}

export async function POST(req: Request) {
  const { userId, forbidden } = await actor();
  if (!userId) return NextResponse.json({ error: forbidden ? "Resident access required." : "Not authenticated." },
    { status: forbidden ? 403 : 401 });
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
    const stripe = getStripe();
    const before = await stripe.paymentIntents.retrieve(id);
    const db = createSupabaseServiceRoleClient();
    await loadResidentManualAchAttemptForPaymentIntent(db, before, userId);
    await assertTestWorkspaceProviderEffectAllowed({ userId, kind: "payment",
      summary: "Bank microdeposit verification refused for a test workspace.", db });
    if (before.status !== "requires_action" ||
        before.next_action?.type !== "verify_with_microdeposits") {
      return NextResponse.json({ error: "This bank payment is not awaiting verification." }, { status: 409 });
    }
    await stripe.paymentIntents.verifyMicrodeposits(id,
      code ? { descriptor_code: code } : { amounts: amounts as number[] });
    return await answer(id, userId);
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
