import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { ensureVendorConnectAccountId } from "@/lib/stripe-connect-account";
import {
  clearManagerConnectAccountId,
  connectAccountReadyForAchPayouts,
  connectAccountTransfersActive,
  ensureConnectAccountTransfersRequested,
  isStripeConnectAccountAccessError,
  resolveManagerConnectAccountId,
} from "@/lib/stripe-connect";

export const runtime = "nodejs";

/**
 * Ensures a Connect account exists for the signed-in vendor and reports its
 * readiness. PLAN-0920-0853: embedded onboarding (mounted via
 * `/api/vendor/stripe-connect/account-session`) replaces the redirect to
 * Stripe and the Express Dashboard login link — no Stripe-hosted URL here.
 *
 * A saved account id Stripe can no longer retrieve is NEVER cleared silently
 * — see the manager twin (`/api/stripe/connect/onboard`) for the full
 * rationale. It is kept as-is and reported as `needsRelink`; only an explicit
 * `{ relink: true }` body (the vendor's own "Reconnect" action) clears it and
 * creates a fresh one, and the id being replaced is logged first.
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

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (String(profile?.role ?? "").toLowerCase() !== "vendor") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const relink = (body as { relink?: unknown } | null)?.relink === true;

    try {
      const stripe = getStripe();
      if (relink) {
        const staleAccountId = await resolveManagerConnectAccountId(supabase, user.id);
        if (staleAccountId) {
          console.error(
            `[stripe-connect] vendor onboard relink: replacing account ${staleAccountId} for ${user.id}`,
          );
          await clearManagerConnectAccountId(supabase, user.id);
        }
      }
      const accountId = await ensureVendorConnectAccountId(stripe, supabase, {
        userId: user.id,
        email: user.email ?? undefined,
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
