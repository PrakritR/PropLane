/**
 * The applicant pays for the check their listing requires BEFORE applying (Checkr Starter, plus the ID add-on when
 * Verify ID runs on Checkr) through PropLane Stripe Checkout. Payment-first, like the post-application flow: this
 * route only collects payment and records the FCRA authorization on the session; the Checkr order is placed by the
 * Stripe webhook / `checkout-verify` (`fulfillPreApplyFromSession`, idempotent on the session id).
 *
 * Fails closed: not required, ID check unavailable, no authorization, wrong disclosure version, or an order that
 * already covers the requirements each refuse before any Stripe session exists. The amount is the server catalog's.
 */
import { NextResponse } from "next/server";

import { resolveAppOrigin } from "@/lib/app-url";
import { checkrSkipsManagerCardCharge } from "@/lib/checkr/config";
import { checkrAddOnCatalog, formatCheckrPrice } from "@/lib/checkr/packages";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { FCRA_DISCLOSURE_VERSION } from "@/lib/screening/applicant-screening";
import { loadPreApplyContext, placePreApplyOrder, resolvePreApplyView } from "@/lib/screening/preapply.server";
import { SCREENING_CHECKOUT_PURPOSE } from "@/lib/stripe-screening";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";

export const runtime = "nodejs";

type Body = {
  propertyId?: string;
  authorize?: boolean;
  disclosureVersion?: string;
  /** App path Stripe returns to after payment (starts with a single "/"). */
  returnPath?: string;
};

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!(await rateLimit(`preapply-checkout:${user.id}:${clientIpFrom(req)}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const propertyId = body.propertyId?.trim();
    if (!propertyId) return NextResponse.json({ error: "propertyId is required." }, { status: 400 });
    const returnPath = body.returnPath?.trim() ?? "";
    if (!returnPath.startsWith("/") || returnPath.startsWith("//")) {
      return NextResponse.json({ error: "returnPath is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const ctx = await loadPreApplyContext(db, user, propertyId);
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

    await assertTestWorkspaceProviderEffectAllowed({
      userId: ctx.managerUserId,
      kind: "payment",
      summary: "Pre-apply screening checkout refused for a test workspace.",
      db,
    });

    const resolved = await resolvePreApplyView(db, ctx);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    const { plan, orderAllowed } = resolved.view;
    if (plan.verifyId.unavailable) {
      return NextResponse.json({ error: "ID check unavailable.", code: "ID_CHECK_UNAVAILABLE" }, { status: 503 });
    }
    if (!plan.order) {
      return NextResponse.json({ error: "No check is required for this listing.", code: "not_offered" }, { status: 403 });
    }
    if (!orderAllowed) {
      return NextResponse.json({ error: "This requirement is already covered.", code: "already_screened" }, { status: 409 });
    }
    // No order and no charge without the applicant's authorization of THIS disclosure text.
    if (body.authorize !== true || body.disclosureVersion !== FCRA_DISCLOSURE_VERSION) {
      return NextResponse.json(
        { error: "Read the disclosure and authorize the report to continue.", code: "authorization_required" },
        { status: 400 },
      );
    }
    const authorization = { disclosureVersion: FCRA_DISCLOSURE_VERSION, authorizedAt: new Date().toISOString() };
    const { quote } = plan.order;

    // Simulate-only environments (no Checkr key) have nothing to charge; local development only.
    if (checkrSkipsManagerCardCharge()) {
      const placed = await placePreApplyOrder(db, {
        userId: ctx.userId,
        email: ctx.email,
        propertyId,
        managerUserId: ctx.managerUserId,
        addOnProducts: quote.addOnProducts,
        authorization,
      });
      if (!placed.ok) return NextResponse.json({ error: placed.error, code: placed.code }, { status: placed.status });
      return NextResponse.json({ ok: true, ran: true });
    }

    const metadata: Record<string, string> = {
      purpose: SCREENING_CHECKOUT_PURPOSE,
      preapply: "1",
      property_id: propertyId,
      manager_user_id: ctx.managerUserId,
      package_slug: quote.packageSlug,
      add_on_products: quote.addOnProducts.join(","),
      payer: "applicant",
      payer_user_id: user.id,
      fcra_authorized_at: authorization.authorizedAt,
      fcra_disclosure_version: authorization.disclosureVersion,
    };
    const addOnName = checkrAddOnCatalog().find((entry) => entry.slug === "identity_verification")?.name ?? "ID check";
    const lineItems = [
      {
        price_data: {
          currency: "usd" as const,
          product_data: { name: `${quote.packageName} background check` },
          unit_amount: quote.packageCents,
        },
        quantity: 1,
      },
      ...(quote.idCheckCents > 0
        ? [
            {
              price_data: {
                currency: "usd" as const,
                product_data: { name: addOnName },
                unit_amount: quote.idCheckCents,
              },
              quantity: 1,
            },
          ]
        : []),
    ];

    const origin = resolveAppOrigin(req);
    const separator = returnPath.includes("?") ? "&" : "?";
    const session = await getStripe().checkout.sessions.create({
      ui_mode: "embedded_page",
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: user.email ?? undefined,
      line_items: lineItems,
      metadata,
      payment_intent_data: { metadata },
      client_reference_id: user.id,
      return_url: `${origin}${returnPath}${separator}preapply=return&session_id={CHECKOUT_SESSION_ID}`,
    });
    if (!session.client_secret) {
      return NextResponse.json({ error: "Stripe did not return a client secret." }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      mode: "embedded",
      clientSecret: session.client_secret,
      sessionId: session.id,
      totalCents: quote.totalCents,
      totalLabel: formatCheckrPrice(quote.totalCents),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to start screening checkout.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
