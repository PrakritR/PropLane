/**
 * The applicant pays for their own background check (Checkr Starter, plus the ID check when the listing asks for
 * it) through PropLane Stripe Checkout. Payment-first, like the manager flow: this route only collects payment and
 * records the applicant's FCRA authorization on the session; the Checkr order is placed by the Stripe webhook
 * (`runScreeningFromStripeSession`, idempotent on the session id).
 *
 * Fails closed: not offered, ID check unavailable, no authorization, wrong disclosure version, or an existing
 * check each refuse before any Stripe session exists. The amount is the server catalog's, never the body's.
 */
import { NextResponse } from "next/server";

import { resolveAppOrigin } from "@/lib/app-url";
import { precheckBackgroundCheckOrder, runBackgroundCheck } from "@/lib/checkr/background-check";
import { checkrSkipsManagerCardCharge } from "@/lib/checkr/config";
import { checkrAddOnCatalog, formatCheckrPrice } from "@/lib/checkr/packages";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { FCRA_DISCLOSURE_VERSION } from "@/lib/screening/applicant-screening";
import { loadApplicantScreeningContext } from "@/lib/screening/applicant-screening-access.server";
import { resolveApplicantScreeningView } from "@/lib/screening/applicant-offer.server";
import { SCREENING_CHECKOUT_PURPOSE } from "@/lib/stripe-screening";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";

export const runtime = "nodejs";

type Body = {
  applicationId?: string;
  /** The applicant ticked the FCRA authorization on the card. */
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
    if (!(await rateLimit(`applicant-screening-checkout:${user.id}:${clientIpFrom(req)}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const applicationId = body.applicationId?.trim();
    if (!applicationId) return NextResponse.json({ error: "applicationId is required." }, { status: 400 });
    const returnPath = body.returnPath?.trim() ?? "";
    if (!returnPath.startsWith("/") || returnPath.startsWith("//")) {
      return NextResponse.json({ error: "returnPath is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const ctx = await loadApplicantScreeningContext(db, user, applicationId);
    if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

    await assertTestWorkspaceProviderEffectAllowed({
      userId: ctx.managerUserId,
      kind: "payment",
      summary: "Applicant screening checkout refused for a test workspace.",
      db,
    });

    const view = await resolveApplicantScreeningView(db, ctx);
    if (view.check) {
      return NextResponse.json({ error: "This application already has a background check.", code: "already_screened" }, { status: 409 });
    }
    if (view.offer.kind === "id_unavailable") {
      return NextResponse.json({ error: "ID check unavailable.", code: "ID_CHECK_UNAVAILABLE" }, { status: 503 });
    }
    if (view.offer.kind !== "offer") {
      return NextResponse.json({ error: "Screening is not offered for this listing.", code: "not_offered" }, { status: 403 });
    }
    // No order and no charge without the applicant's authorization of THIS disclosure text.
    if (body.authorize !== true || body.disclosureVersion !== FCRA_DISCLOSURE_VERSION) {
      return NextResponse.json(
        { error: "Read the disclosure and authorize the report to continue.", code: "authorization_required" },
        { status: 400 },
      );
    }
    const authorization = { disclosureVersion: FCRA_DISCLOSURE_VERSION, authorizedAt: new Date().toISOString() };
    const { quote } = view.offer;

    const precheck = await precheckBackgroundCheckOrder({
      db,
      applicationId,
      managerUserId: ctx.managerUserId,
      payer: "applicant",
      authorization,
    });
    if (!precheck.ok) {
      return NextResponse.json({ error: precheck.error, code: precheck.code }, { status: precheck.status });
    }

    // Simulate-only environments (no Checkr key) have nothing to charge; local development only.
    if (checkrSkipsManagerCardCharge()) {
      const result = await runBackgroundCheck({
        db,
        applicationId,
        managerUserId: ctx.managerUserId,
        packageSlug: quote.packageSlug,
        addOnProducts: quote.addOnProducts,
        payer: "applicant",
        authorization,
      });
      if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
      return NextResponse.json({ ok: true, ran: true });
    }

    const metadata: Record<string, string> = {
      purpose: SCREENING_CHECKOUT_PURPOSE,
      application_id: applicationId,
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
      return_url: `${origin}${returnPath}${separator}screening=return&session_id={CHECKOUT_SESSION_ID}`,
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
