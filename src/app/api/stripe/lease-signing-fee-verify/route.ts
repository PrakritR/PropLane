import { NextResponse } from "next/server";

import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import {
  isLeaseSigningFeeCheckoutSession,
  markResidentLeaseSigningFeePaid,
} from "@/lib/lease-signing-fee-resident.server";
import { getStripe } from "@/lib/stripe";
import { axisAchCheckoutPaid, axisAchCheckoutProcessing } from "@/lib/stripe-axis-ach-checkout";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Confirms a lease signing fee Checkout Session on return from Stripe.
 *
 * The lease id and payer come from the session metadata, not the query string,
 * and the session must name the signed-in resident — a session id alone is not
 * authorization to mark someone else's lease paid.
 */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("session_id")?.trim() ?? "";
  if (!sessionId) return NextResponse.json({ error: "Missing session_id" }, { status: 400 });

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.id) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db
      .from("profiles")
      .select("email, role")
      .eq("id", user.id)
      .maybeSingle();
    const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    if (!isResident) return NextResponse.json({ error: "Residents only." }, { status: 403 });

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isLeaseSigningFeeCheckoutSession(session)) {
      return NextResponse.json({ error: "Not a lease signing fee checkout session." }, { status: 400 });
    }
    if ((session.metadata?.resident_user_id ?? "").trim() !== user.id) {
      return NextResponse.json({ error: "This payment does not belong to your account." }, { status: 403 });
    }

    const leaseId = (session.metadata?.lease_id ?? "").trim();
    if (!leaseId) return NextResponse.json({ error: "Payment is missing its lease." }, { status: 400 });

    const paid = axisAchCheckoutPaid(session);
    const processing = axisAchCheckoutProcessing(session);
    if (!paid) {
      return NextResponse.json({
        paid: false,
        processing,
        leaseId,
        error: processing ? "Payment is still clearing." : "Payment is not completed yet.",
      });
    }

    const result = await markResidentLeaseSigningFeePaid(db, {
      leaseId,
      residentUserId: user.id,
      residentEmail: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    return NextResponse.json({ paid: true, processing: false, leaseId, alreadyPaid: result.alreadyPaid });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to verify payment.";
    if (message.includes("STRIPE_SECRET_KEY") || message.includes("Missing STRIPE")) {
      return NextResponse.json({ error: "Payments are not configured." }, { status: 503 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
