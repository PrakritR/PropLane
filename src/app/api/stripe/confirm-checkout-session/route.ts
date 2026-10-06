import { NextResponse } from "next/server";
import { reconcileManagerPurchaseWithStripe } from "@/lib/manager-stripe-subscription-sync";
import { adoptPaidPortalCheckoutForOwner, checkoutSessionIndicatesPaidPurchase, recordPaidManagerCheckoutSession } from "@/lib/manager-purchase-from-session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * After Stripe redirects back with `session_id`, persist subscription + tier even if the
 * webhook was delayed or skipped (common on local dev / misconfigured STRIPE_WEBHOOK_SECRET).
 */
export async function POST(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as { sessionId?: string } | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    const ref = session.client_reference_id?.trim();
    const metaUid = session.metadata?.userId?.trim();
    if (ref !== user.id && metaUid !== user.id) {
      return NextResponse.json({ error: "This checkout session does not belong to your account." }, { status: 403 });
    }
    if (!checkoutSessionIndicatesPaidPurchase(session)) {
      return NextResponse.json({ ok: false, processing: true }, { status: 202 });
    }

    await adoptPaidPortalCheckoutForOwner(session, user.id);
    await recordPaidManagerCheckoutSession(session);
    try {
      await reconcileManagerPurchaseWithStripe(user.id);
    } catch {
      /* best-effort; GET /subscription will retry sync */
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to confirm checkout";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
