import { NextResponse } from "next/server";
import { loadManagerBillingIdentity } from "@/lib/manager-stripe-customer.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { resolveAppOrigin } from "@/lib/app-url";
import { getStripe } from "@/lib/stripe";
import { MANAGER_PLAN_BILLING_RETURN_PATH } from "@/lib/portals/manager-plan-path";

export const runtime = "nodejs";

function allowedReturnPath(
  path: string | undefined,
): typeof MANAGER_PLAN_BILLING_RETURN_PATH {
  void path;
  return MANAGER_PLAN_BILLING_RETURN_PATH;
}

export async function POST(req: Request) {
  try {
    const actor = await requireManagerRouteUser();
    if (!actor)
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      returnPath?: string;
    };
    const returnPath = allowedReturnPath(body.returnPath);

    const { customerId } = await loadManagerBillingIdentity(
      actor.db,
      actor.userId,
    );
    const stripe = getStripe();
    if (!customerId) {
      return NextResponse.json(
        { error: "No Stripe customer on file." },
        { status: 400 },
      );
    }

    const origin = resolveAppOrigin(req);
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}${returnPath}`,
    });

    return NextResponse.json({ url: session.url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
