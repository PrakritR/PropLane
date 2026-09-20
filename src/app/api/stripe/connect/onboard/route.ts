import { NextResponse } from "next/server";
import { assertCoManagerBankAccountAccess } from "@/lib/auth/co-manager-bank-account-access";
import {
  resolveStripePayoutContext,
  stripePayoutContextError,
} from "@/lib/auth/manager-stripe-payout-access.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { ensureManagerConnectAccountId } from "@/lib/stripe-connect-account";
import {
  connectAccountReadyForAchPayouts,
  connectAccountTransfersActive,
  ensureConnectAccountTransfersRequested,
  isStripeConnectAccountAccessError,
  clearManagerConnectAccountId,
  resolveManagerConnectAccountId,
  retrieveManagerConnectAccountOrNull,
} from "@/lib/stripe-connect";

export const runtime = "nodejs";

/**
 * Ensures a Connect account exists for the signed-in user (creating one if
 * needed) and reports its readiness. PLAN-0920-0853 replaces the redirect to
 * Stripe (Account Links) and the Express Dashboard login link with embedded
 * onboarding — the client mounts `account_onboarding` via
 * `/api/stripe/connect/account-session` in PropLane's own modal, so this
 * route no longer mints or returns any Stripe-hosted URL.
 *
 * A saved account id Stripe can no longer retrieve is NEVER cleared silently
 * — that used to happen on every access error, even on a routine load, which
 * meant a transient platform-key hiccup could strand a manager's saved id
 * with no chance to recover it. It is now kept as-is and reported as
 * `needsRelink`; only an explicit `{ relink: true }` body (the user's own
 * "Reconnect" action) clears it and creates a fresh one, and the id being
 * replaced is logged first.
 */
export async function POST(req: Request) {
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
    if (!payout.payoutOwnerUserId) {
      return NextResponse.json(
        { error: stripePayoutContextError(payout.unresolvedReason) },
        { status: payout.unresolvedReason === "ambiguous_owner" ? 409 : 500 },
      );
    }
    const access = await assertCoManagerBankAccountAccess(service, user.id, payout.payoutOwnerUserId, "edit");
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const payoutOwnerId = payout.payoutOwnerUserId;
    const body = await req.json().catch(() => null);
    const relink = (body as { relink?: unknown } | null)?.relink === true;

    const { data: ownerProfile } = await service
      .from("profiles")
      .select("email")
      .eq("id", payoutOwnerId)
      .maybeSingle();

    try {
      const stripe = getStripe();
      if (relink) {
        // Explicit user action ("Reconnect" / "Start over"): log the id being
        // replaced, then clear it before creating a fresh account.
        const staleAccountId = await resolveManagerConnectAccountId(service, payoutOwnerId);
        if (staleAccountId && (await retrieveManagerConnectAccountOrNull(stripe, staleAccountId))) {
          return NextResponse.json(
            { code: "CONNECT_ACCOUNT_HEALTHY", error: "Your saved Stripe account is still connected." },
            { status: 409 },
          );
        }
        if (staleAccountId) {
          console.error(
            `[stripe-connect] onboard relink: replacing account ${staleAccountId} for owner ${payoutOwnerId} (requested by ${user.id})`,
          );
          await clearManagerConnectAccountId(service, payoutOwnerId);
        }
      }
      const accountId = await ensureManagerConnectAccountId(stripe, service, {
        userId: payoutOwnerId,
        email: ownerProfile?.email ?? user.email ?? undefined,
        // Never let this call silently wipe a saved id on its own — only the
        // explicit relink branch above may replace it, and it already has.
        allowClearStale: false,
      });

      const acct = await ensureConnectAccountTransfersRequested(stripe, accountId);

      return NextResponse.json({
        mode: "embedded" as const,
        accountId,
        connected: connectAccountTransfersActive(acct),
        paymentReady: connectAccountReadyForAchPayouts(acct),
        detailsSubmitted: Boolean(acct.details_submitted),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json(
          {
            code: "STRIPE_NOT_CONFIGURED",
            error: "Stripe is not configured (missing STRIPE_SECRET_KEY).",
          },
          { status: 503 },
        );
      }
      if (msg.includes("signed up for Connect")) {
        return NextResponse.json(
          {
            code: "CONNECT_NOT_ENABLED",
            error:
              "Stripe Connect is not activated yet. In the Stripe Dashboard (live mode), open Connect and complete setup, then try again.",
          },
          { status: 400 },
        );
      }
      // The saved account id stays exactly as it was — refuse and ask for an
      // explicit relink rather than wiping it on an error the platform key
      // could be reporting only transiently.
      if (isStripeConnectAccountAccessError(msg)) {
        return NextResponse.json(
          {
            code: "CONNECT_ACCOUNT_NEEDS_RELINK",
            needsRelink: true,
            error: "We couldn't reach your saved Stripe account. Reconnect to start over.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ code: "STRIPE_CONNECT_ERROR", error: msg }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
