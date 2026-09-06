import { NextResponse } from "next/server";
import { isAxisIntentSessionId } from "@/lib/manager-signup-intent";
import { recordPaidManagerCheckoutSession } from "@/lib/manager-purchase-from-session";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function normalizeCheckoutSessionId(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, "").trim();
}

async function previewFromPurchaseRow(sessionId: string) {
  const supabase = createSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .from("manager_purchases")
    .select("manager_id, email, full_name, tier")
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();

  if (error || !row?.manager_id || !row.email) return null;

  return NextResponse.json({
    managerId: row.manager_id,
    email: row.email,
    fullName: row.full_name?.trim() || null,
    tier: row.tier?.trim().toLowerCase() || "pro",
  });
}

/**
 * Public read of checkout session fields needed to finish manager signup (no secrets).
 * Used by Create account after Stripe redirect or free / promo-skip intent.
 */
export async function GET(req: Request) {
  try {
    if (!(await rateLimit(`checkout-preview:${clientIpFrom(req)}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const { searchParams } = new URL(req.url);
    const sessionId = normalizeCheckoutSessionId(searchParams.get("session_id"));
    if (!sessionId) {
      return NextResponse.json({ error: "session_id is required." }, { status: 400 });
    }

    if (isAxisIntentSessionId(sessionId)) {
      const fromDb = await previewFromPurchaseRow(sessionId);
      if (fromDb) return fromDb;
      return NextResponse.json({ error: "Unknown or expired signup link." }, { status: 400 });
    }

    const stripe = getStripe();
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (stripeErr) {
      const fromDb = await previewFromPurchaseRow(sessionId);
      if (fromDb) return fromDb;
      const message = stripeErr instanceof Error ? stripeErr.message : "Could not load checkout session.";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const paid =
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required" ||
      session.status === "complete";
    if (!paid) {
      return NextResponse.json({ error: "Checkout is not complete yet." }, { status: 400 });
    }

    try {
      await recordPaidManagerCheckoutSession(session);
    } catch {
      /* Webhook may have already written the row; preview can still proceed. */
    }

    const managerId = session.metadata?.manager_id?.trim();
    const email = (
      session.customer_details?.email ??
      session.customer_email ??
      session.metadata?.email
    )
      ?.trim()
      .toLowerCase();
    const fullName = session.metadata?.full_name?.trim() ?? "";

    const tierMeta = session.metadata?.tier?.trim().toLowerCase() || "pro";

    if (!managerId || !email) {
      const fromDb = await previewFromPurchaseRow(sessionId);
      if (fromDb) return fromDb;
      return NextResponse.json({ error: "This session does not include manager signup details." }, { status: 400 });
    }

    return NextResponse.json({
      managerId,
      email,
      fullName: fullName || null,
      tier: tierMeta,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load checkout session.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
