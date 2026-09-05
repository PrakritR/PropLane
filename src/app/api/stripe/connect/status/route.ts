import { NextResponse } from "next/server";
import {
  resolveStripePayoutContext,
  stripePayoutContextError,
} from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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

export const runtime = "nodejs";

/**
 * Returns Connect state for the signed-in user (Express dashboard vs onboarding).
 * Without Stripe keys, returns demo + profile row only if account id was stored.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const service = createSupabaseServiceRoleClient();
    const payout = await resolveStripePayoutContext(service, user.id);
    const payoutOwnerUserId = payout.payoutOwnerUserId;
    if (!payoutOwnerUserId) {
      return NextResponse.json(
        { error: stripePayoutContextError(payout.unresolvedReason) },
        { status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500 },
      );
    }

    const { data: profile } = await service
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("id", payoutOwnerUserId)
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
        payoutOwnerUserId,
        canEditBankAccount: payout.canEditBankAccount,
        isCoManagerForPayout: payout.isCoManagerForPayout,
      });
    }

    try {
      const stripe = getStripe();
      const existing = await retrieveManagerConnectAccountOrNull(stripe, accountId);
      if (!existing) {
        // Clearing rewrites the OWNER's profile, so it needs the same authority a
        // bank change needs — a read-only co-manager reports the stale state and
        // leaves the row alone.
        if (payout.canEditBankAccount) await clearManagerConnectAccountId(service, payoutOwnerUserId);
        return NextResponse.json({
          connected: false,
          accountId: null,
          chargesEnabled: false,
          payoutsEnabled: false,
          transfersEnabled: false,
          paymentReady: false,
          detailsSubmitted: false,
          payoutOwnerUserId,
          canEditBankAccount: payout.canEditBankAccount,
          isCoManagerForPayout: payout.isCoManagerForPayout,
          stripeError:
            "Your saved Stripe payout account is no longer linked to this platform. Connect again below.",
        });
      }

      const acct = await ensureConnectAccountTransfersRequested(stripe, accountId);
      const transfersEnabled = connectAccountTransfersActive(acct);
      const paymentReady = connectAccountReadyForAchPayouts(acct);
      return NextResponse.json({
        connected: true,
        accountId: acct.id,
        chargesEnabled: Boolean(acct.charges_enabled),
        payoutsEnabled: Boolean(acct.payouts_enabled),
        transfersEnabled,
        paymentReady,
        transfersStatus: acct.capabilities?.transfers ?? null,
        detailsSubmitted: Boolean(acct.details_submitted),
        payoutOwnerUserId,
        canEditBankAccount: payout.canEditBankAccount,
        isCoManagerForPayout: payout.isCoManagerForPayout,
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
