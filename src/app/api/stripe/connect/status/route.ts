import { NextResponse } from "next/server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import {
  resolveStripePayoutContext,
  stripePayoutContextError,
} from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import {
  connectAccountReadyForAchPayouts,
  connectAccountTransfersActive,
  ensureConnectAccountTransfersRequested,
  isStripeConnectAccountAccessError,
  retrieveManagerConnectAccountOrNull,
} from "@/lib/stripe-connect";
import { resolvePayoutsReadiness } from "@/lib/stripe-payouts-readiness.server";

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
    // A co-manager with no `bankAccount` grant at all (e.g. the "Leasing"
    // role preset, which never touches this module) must never see the
    // owner's Stripe Connect readiness, balance figures, or identity state —
    // this route previously had NO gate here at all, so resolving to a real
    // owner id was enough on its own to read everything below.
    const access = await assertCoManagerBankAccountAccess(service, user.id, payoutOwnerUserId, "read");
    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, isCoManagerForPayout: payout.isCoManagerForPayout, canViewBankAccount: false },
        { status: access.status },
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
        // A status read never rewrites the owner's profile: the saved id is
        // kept and reported as `needsRelink`, and only the user's explicit
        // Reconnect (`/onboard` with `{ relink: true }`) may replace it.
        return NextResponse.json({
          connected: false,
          accountId,
          needsRelink: true,
          chargesEnabled: false,
          payoutsEnabled: false,
          transfersEnabled: false,
          paymentReady: false,
          detailsSubmitted: false,
          payoutOwnerUserId,
          canEditBankAccount: payout.canEditBankAccount,
          isCoManagerForPayout: payout.isCoManagerForPayout,
          stripeError: "We couldn't reach your saved Stripe account. Reconnect to start over.",
        });
      }

      // `ensureConnectAccountTransfersRequested` PATCHes the Connect account when the
      // transfers capability has not been requested, so a read-only co-manager loading
      // a status page would mutate the owner's Stripe account. They report on the
      // account already retrieved above; only a caller who may change bank details
      // requests the capability.
      const acct = payout.canEditBankAccount
        ? await ensureConnectAccountTransfersRequested(stripe, accountId)
        : existing;
      const transfersEnabled = connectAccountTransfersActive(acct);
      const paymentReady = connectAccountReadyForAchPayouts(acct);
      // The ONE payouts-ready decision (identity verified + a verified payout
      // destination) — see `stripe-payouts-readiness.server.ts`. Distinct
      // from `paymentReady` above, which is Stripe's own charges-acceptance
      // signal ("can this account receive resident payments at all").
      const payoutsReady = resolvePayoutsReadiness(acct).ready;
      return NextResponse.json({
        connected: true,
        accountId: acct.id,
        chargesEnabled: Boolean(acct.charges_enabled),
        payoutsEnabled: Boolean(acct.payouts_enabled),
        transfersEnabled,
        paymentReady,
        payoutsReady,
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
      const needsRelink = isStripeConnectAccountAccessError(msg);
      return NextResponse.json({
        connected: !needsRelink,
        accountId,
        needsRelink,
        chargesEnabled: false,
        payoutsEnabled: false,
        transfersEnabled: false,
        paymentReady: false,
        detailsSubmitted: false,
        stripeError: needsRelink ? "We couldn't reach your saved Stripe account. Reconnect to start over." : msg,
      });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
