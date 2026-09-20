import { NextResponse } from "next/server";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { getStripe } from "@/lib/stripe";
import {
  ensureResidentStripeCustomerId,
  listResidentSavedPaymentMethods,
  setResidentDefaultPaymentMethod,
} from "@/lib/stripe-resident-customer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  assertTestWorkspaceProviderEffectAllowed,
  TestWorkspaceProviderDisabledError,
} from "@/lib/test-workspaces/effects.server";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (isDemoModeActive()) {
      return NextResponse.json({ methods: [] });
    }

    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user?.email) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const db = createSupabaseServiceRoleClient();
    await assertTestWorkspaceProviderEffectAllowed({
      userId: user.id,
      kind: "payment",
      summary: "Saved payment method access refused for a test workspace.",
      db,
    });
    const { data: profile } = await db
      .from("profiles")
      .select("stripe_customer_id, full_name, role")
      .eq("id", user.id)
      .maybeSingle();

    const customerId = profile?.stripe_customer_id?.trim();
    if (!customerId) {
      return NextResponse.json({ methods: [] });
    }

    const stripe = getStripe();
    const methods = await listResidentSavedPaymentMethods(stripe, customerId);
    return NextResponse.json({ methods });
  } catch (e) {
    if (e instanceof TestWorkspaceProviderDisabledError) {
      return NextResponse.json({ error: "Payments are unavailable for test accounts." }, { status: 403 });
    }
    const message = e instanceof Error ? e.message : "Failed to load payment methods.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    if (isDemoModeActive()) {
      return NextResponse.json({ error: "Payment methods are unavailable in demo mode." }, { status: 400 });
    }

    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user?.email) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const body = (await req.json()) as { kind?: string; returnUrl?: string };
    const kind = body.kind === "card" ? "card" : "ach";
    const returnUrl = String(body.returnUrl ?? "").trim();
    if (!returnUrl) {
      return NextResponse.json({ error: "returnUrl is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    await assertTestWorkspaceProviderEffectAllowed({
      userId: user.id,
      kind: "payment",
      summary: "Saved payment method setup refused for a test workspace.",
      db,
    });
    const { data: profile } = await db
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();

    const stripe = getStripe();
    const customerId = await ensureResidentStripeCustomerId(
      stripe,
      db,
      user.id,
      user.email,
      profile?.full_name,
    );

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "setup",
      customer: customerId,
      return_url: returnUrl,
      ...(kind === "card"
        ? { payment_method_types: ["card"] }
        : {
            payment_method_types: ["us_bank_account"],
            payment_method_options: {
              us_bank_account: {
                financial_connections: { permissions: ["payment_method"] },
                verification_method: "automatic",
              },
            },
          }),
    } as unknown as Parameters<typeof stripe.checkout.sessions.create>[0]);

    if (!session.client_secret) {
      return NextResponse.json({ error: "Stripe did not return a client secret." }, { status: 500 });
    }

    return NextResponse.json({ clientSecret: session.client_secret, kind });
  } catch (e) {
    if (e instanceof TestWorkspaceProviderDisabledError) {
      return NextResponse.json({ error: "Payments are unavailable for test accounts." }, { status: 403 });
    }
    const message = e instanceof Error ? e.message : "Could not start payment method setup.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    if (isDemoModeActive()) {
      return NextResponse.json({ error: "Payment methods are unavailable in demo mode." }, { status: 400 });
    }

    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user?.email) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }

    const body = (await req.json()) as { paymentMethodId?: string };
    const paymentMethodId = String(body.paymentMethodId ?? "").trim();
    if (!paymentMethodId) {
      return NextResponse.json({ error: "paymentMethodId is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    await assertTestWorkspaceProviderEffectAllowed({
      userId: user.id,
      kind: "payment",
      summary: "Saved payment method update refused for a test workspace.",
      db,
    });
    const { data: profile } = await db
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();

    const customerId = profile?.stripe_customer_id?.trim();
    if (!customerId) {
      return NextResponse.json({ error: "No saved payment methods yet." }, { status: 404 });
    }

    const stripe = getStripe();
    await setResidentDefaultPaymentMethod(stripe, customerId, paymentMethodId);
    const methods = await listResidentSavedPaymentMethods(stripe, customerId);
    return NextResponse.json({ methods });
  } catch (e) {
    if (e instanceof TestWorkspaceProviderDisabledError) {
      return NextResponse.json({ error: "Payments are unavailable for test accounts." }, { status: 403 });
    }
    const message = e instanceof Error ? e.message : "Could not set default payment method.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
