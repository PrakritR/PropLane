import { NextResponse } from "next/server";
import { authorizePlaidPurpose } from "@/lib/plaid/access.server";
import { getPlaidClient, logPlaidFailure } from "@/lib/plaid/client.server";
import { payManualAchWithPlaidBank } from "@/lib/plaid/resident-pay.server";
import { loadResidentManualAchAttemptForPaymentIntent } from "@/lib/resident-checkout-claim.server";
import { answerResidentAchPayment } from "@/lib/resident-ach-payment.server";
import { getStripe } from "@/lib/stripe";
import { ensureResidentStripeCustomerId } from "@/lib/stripe-resident-customer";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Pay a resident's manual-ACH PaymentIntent from the bank they linked with Plaid. Gate order is
 * the typed path's: resident role, test-workspace gate (both inside `authorizePlaidPurpose`),
 * then Stripe. The resident is the session user; the body names only the PaymentIntent and our
 * own Plaid item row, both re-checked against that user.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as
      { paymentIntentId?: unknown; plaidItemId?: unknown; authorized?: unknown } | null;
    const paymentIntentId = typeof body?.paymentIntentId === "string" ? body.paymentIntentId.trim() : "";
    const plaidItemId = typeof body?.plaidItemId === "string" ? body.plaidItemId.trim() : "";
    if (!paymentIntentId || !plaidItemId) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
    }
    const actor = await authorizePlaidPurpose("resident_pay");
    if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status, headers: NO_STORE });

    const { data: profile, error } = await actor.db.from("profiles")
      .select("full_name").eq("id", actor.userId).maybeSingle();
    if (error) throw error;
    const { data: authUser } = await actor.db.auth.admin.getUserById(actor.userId);
    const stripe = getStripe();
    const email = String(authUser?.user?.email ?? "").trim();
    if (!email) return NextResponse.json({ error: "Bank payment needs review." }, { status: 409, headers: NO_STORE });
    const stripeCustomerId = await ensureResidentStripeCustomerId(stripe, actor.db, actor.userId, email, profile?.full_name);

    const result = await payManualAchWithPlaidBank(
      { db: actor.db, plaid: getPlaidClient(), stripe, assertAttempt: loadResidentManualAchAttemptForPaymentIntent },
      {
        userId: actor.userId,
        stripeCustomerId,
        paymentIntentId,
        plaidItemId,
        authorized: body?.authorized === true,
        ip: (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "0.0.0.0",
        userAgent: req.headers.get("user-agent")?.slice(0, 200) || "unknown",
      },
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
    return answerResidentAchPayment(paymentIntentId, actor.userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("does not belong")) {
      return NextResponse.json({ error: "Bank payment is not yours." }, { status: 403, headers: NO_STORE });
    }
    logPlaidFailure("[plaid] resident pay failed", error);
    return NextResponse.json({ error: "Bank payment needs review." }, { status: 409, headers: NO_STORE });
  }
}
