import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import {
  clearManagerConnectAccountId,
  connectAccountReadyForAchPayouts,
  connectAccountTransfersActive,
  ensureConnectAccountTransfersRequested,
  isStripeConnectAccountAccessError,
  retrieveManagerConnectAccountOrNull,
} from "@/lib/stripe-connect";
import { retryFailedVendorPayoutsForVendor } from "@/lib/stripe-vendor-payout";

export const runtime = "nodejs";

/**
 * Returns Connect state for the signed-in vendor (Express dashboard vs onboarding).
 * Without Stripe keys, returns demo + profile row only if account id was stored.
 */
export async function GET() {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }
    const userId = access.actor.userId;

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("id", userId)
      .maybeSingle();

    const accountId =
      (profile as { stripe_connect_account_id?: string | null } | null)?.stripe_connect_account_id?.trim() ?? null;

    if (!accountId?.trim()) {
      return NextResponse.json({
        connected: false,
        accountId: null,
        chargesEnabled: false,
        payoutsEnabled: false,
        transfersEnabled: false,
        paymentReady: false,
        detailsSubmitted: false,
      });
    }

    try {
      const stripe = getStripe();
      const existing = await retrieveManagerConnectAccountOrNull(stripe, accountId);
      if (!existing) {
        await clearManagerConnectAccountId(db, userId);
        return NextResponse.json({
          connected: false,
          accountId: null,
          chargesEnabled: false,
          payoutsEnabled: false,
          transfersEnabled: false,
          paymentReady: false,
          detailsSubmitted: false,
          stripeError: "Your saved Stripe payout account is no longer linked to this platform. Connect again below.",
        });
      }

      const acct = await ensureConnectAccountTransfersRequested(stripe, accountId);
      const transfersEnabled = connectAccountTransfersActive(acct);
      const paymentReady = connectAccountReadyForAchPayouts(acct);
      if (paymentReady) {
        await retryFailedVendorPayoutsForVendor(db, userId).catch(() => undefined);
      }
      return NextResponse.json({
        connected: true,
        accountId: acct.id,
        chargesEnabled: Boolean(acct.charges_enabled),
        payoutsEnabled: Boolean(acct.payouts_enabled),
        transfersEnabled,
        paymentReady,
        transfersStatus: acct.capabilities?.transfers ?? null,
        detailsSubmitted: Boolean(acct.details_submitted),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json({
          demo: true,
          connected: Boolean(accountId),
          accountId,
          chargesEnabled: false,
          payoutsEnabled: false,
          transfersEnabled: false,
          paymentReady: false,
          detailsSubmitted: false,
          message:
            "Stripe is not configured on the server; cannot refresh Connect status. Keys present = live status.",
        });
      }
      return NextResponse.json({
        connected: true,
        accountId,
        chargesEnabled: false,
        payoutsEnabled: false,
        transfersEnabled: false,
        paymentReady: false,
        detailsSubmitted: false,
        stripeError: isStripeConnectAccountAccessError(msg)
          ? "Your saved Stripe payout account is no longer linked to this platform. Connect again below."
          : msg,
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
