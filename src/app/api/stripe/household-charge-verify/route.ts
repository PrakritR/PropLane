import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import {
  householdChargeCheckoutProcessing,
  isHouseholdChargeCheckoutSession,
  markHouseholdChargePaidFromStripeSession,
  markHouseholdChargeProcessingFromStripeSession,
} from "@/lib/stripe-household-charge";
import { loadResidentCheckoutAttemptForSession } from "@/lib/resident-checkout-claim.server";
import { creditVerifiedHouseholdCheckoutSource } from "@/lib/household-captured-source.server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";

export const runtime = "nodejs";

/**
 * Confirms a household charge Checkout Session after embedded or hosted ACH checkout.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("session_id")?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session_id" }, { status: 400 });
  }

  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const db = createSupabaseServiceRoleClient();
    const { data: profile, error: profileError } = await db.from("profiles")
      .select("role").eq("id", user.id).maybeSingle();
    if (profileError || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
      return NextResponse.json({ error: "Resident access required." }, { status: 403 });
    }
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!isHouseholdChargeCheckoutSession(session)) {
      return NextResponse.json({ error: "Not a household charge checkout session." }, { status: 400 });
    }
    if (session.metadata?.source_arbitration_v !== "1") {
      return NextResponse.json({ paid: false, processing: false,
        error: "This earlier checkout needs payment review." }, { status: 409 });
    }
    // The original authenticated user id, not a session email that can be
    // reused after deletion, owns verification and binds a lost create stamp.
    const attempt = await loadResidentCheckoutAttemptForSession(db, session, user.id);

    const paid = session.status === "complete" && session.payment_status === "paid" &&
      attempt.payer_total_cents > 0 && Boolean(session.payment_intent);
    const processing = householdChargeCheckoutProcessing(session);

    if (!paid && !processing) {
      return NextResponse.json(
        {
          paid: false,
          processing: false,
          paymentStatus: session.payment_status,
          status: session.status,
          error: "Payment is not completed yet.",
        },
        { status: 200 },
      );
    }

    const chargeId = attempt.charge_ids[0] ?? null;
    let alreadyPaid = false;

    if (paid) {
      const result = await markHouseholdChargePaidFromStripeSession(db, session);
      if (!result.ok) return NextResponse.json({ paid: false, processing: false,
        error: "The payment source could not be settled yet." }, { status: 409 });
      try {
        await creditVerifiedHouseholdCheckoutSource(db, stripe, session);
      } catch {
        return NextResponse.json({ paid: false, processing: false,
          error: "The payment source needs review." }, { status: 409 });
      }
      alreadyPaid = result.alreadyPaid ?? false;
    } else if (processing) {
      // Persist the clearing-window hold immediately on return from checkout —
      // the webhook usually lands first, but this covers delayed delivery.
      const result = await markHouseholdChargeProcessingFromStripeSession(db, session);
      if (!result.ok) return NextResponse.json({ paid: false, processing: false,
        error: "The payment source could not be held as processing." }, { status: 409 });
    }

    return NextResponse.json({
      paid,
      processing,
      paymentStatus: session.payment_status,
      chargeId,
      alreadyPaid,
      sessionId: session.id,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to verify session";
    if (message.includes("does not belong to your account")) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    if (message.includes("checkout attempt") || message.includes("saved attempt")) {
      return NextResponse.json({ paid: false, processing: false, error: "Payment needs review." }, { status: 409 });
    }
    if (message.includes("STRIPE_SECRET_KEY") || message.includes("Missing STRIPE")) {
      return NextResponse.json({ error: "Stripe is not configured on the server." }, { status: 503 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
