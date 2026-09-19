import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";
import { ensureManagerConnectAccountId } from "@/lib/stripe-connect-account";
import { ensureConnectAccountTransfersRequested } from "@/lib/stripe-connect";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const db = createSupabaseServiceRoleClient();

    try {
      const stripe = getStripe();
      const accountId = await ensureManagerConnectAccountId(stripe, db, {
        userId: user.id,
        email: user.email ?? undefined,
      });
      await ensureConnectAccountTransfersRequested(stripe, accountId);

      const sessionComponents = {
        account_onboarding: {
          enabled: true,
          features: {
            disable_stripe_user_authentication: true,
          },
        },
        account_management: { enabled: true },
        balances: { enabled: true },
        payouts: { enabled: true },
        payouts_list: { enabled: true },
      } as const;

      let session;
      try {
        session = await stripe.accountSessions.create({
          account: accountId,
          components: sessionComponents,
        });
      } catch (sessionError) {
        const sessionMsg = sessionError instanceof Error ? sessionError.message : String(sessionError);
        if (!sessionMsg.includes("disable_stripe_user_authentication")) throw sessionError;
        session = await stripe.accountSessions.create({
          account: accountId,
          components: {
            account_onboarding: { enabled: true },
            account_management: { enabled: true },
            balances: { enabled: true },
            payouts: { enabled: true },
            payouts_list: { enabled: true },
          },
        });
      }

      return NextResponse.json({
        clientSecret: session.client_secret,
        accountId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json({
          demo: true,
          message:
            "Stripe is not configured (missing STRIPE_SECRET_KEY). Add keys in your environment to enable live embedded payout setup.",
        });
      }
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
