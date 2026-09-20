import { NextResponse } from "next/server";
import { requireVendorApiAccess } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { ensureVendorConnectAccountId } from "@/lib/stripe-connect-account";
import { isStripeConnectAccountAccessError } from "@/lib/stripe-connect";
import { createAccountSession, isEmbeddedComponent } from "@/lib/stripe-connect-embedded";

export const runtime = "nodejs";

/** Vendor twin of `/api/stripe/connect/account-session` — scoped to the vendor's own Connect account. */
export async function POST(req: Request) {
  try {
    const access = await requireVendorApiAccess();
    if (!access.ok) {
      return NextResponse.json(
        { error: access.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: access.status },
      );
    }

    const body = await req.json().catch(() => null);
    const component = (body as { component?: unknown } | null)?.component;
    if (!isEmbeddedComponent(component)) {
      return NextResponse.json({ error: "Invalid component." }, { status: 400 });
    }

    try {
      const stripe = getStripe();
      const db = createSupabaseServiceRoleClient();
      const accountId = await ensureVendorConnectAccountId(stripe, db, {
        userId: access.actor.userId,
        email: access.actor.email || undefined,
        allowClearStale: false,
      });

      const session = await createAccountSession(stripe, accountId, component);
      return NextResponse.json(session);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Stripe error";
      if (msg.includes("STRIPE_SECRET_KEY") || msg.includes("Missing STRIPE")) {
        return NextResponse.json({
          demo: true,
          message:
            "Stripe is not configured (missing STRIPE_SECRET_KEY). Add keys in your environment to enable live embedded payout setup.",
        });
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
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
