/**
 * Create a Stripe Checkout session for an applicant screening order.
 *
 * Payment-first flow: the manager confirms the package here, pays on Stripe's
 * hosted page, and the Checkr order is placed ONLY by the Stripe webhook after
 * `checkout.session.completed` reports the session paid (see
 * `src/lib/stripe-screening.ts`). Package/add-on pricing is computed
 * server-side from the catalog — never trusted from the client.
 *
 * Pure simulate mode (CHECKR_SIMULATE without an API key) skips payment and
 * runs the simulated check immediately.
 */
import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { collectLinkedPropertyIdsForUser } from "@/lib/auth/manager-lease-scope";
import { resolveAppOrigin } from "@/lib/app-url";
import { track } from "@/lib/analytics/posthog";
import {
  precheckBackgroundCheckOrder,
  runBackgroundCheck,
} from "@/lib/checkr/background-check";
import { checkrSkipsManagerCardCharge } from "@/lib/checkr/config";
import type { CheckrPackage } from "@/lib/checkr/config";
import {
  buildScreeningCheckoutProductName,
  checkrOrderCostCents,
  isCheckrAddOn,
  isCheckrPackage,
  screeningCheckoutDescription,
  type CheckrAddOnSlug,
} from "@/lib/checkr/packages";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { SCREENING_CHECKOUT_PURPOSE } from "@/lib/stripe-screening";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  applicationId?: string;
  packageSlug?: string;
  addOnProducts?: string[];
  /** `embedded` renders Stripe inside the screening modal; default is hosted redirect. */
  mode?: "embedded" | "hosted";
  /** Required for embedded mode — app path returned to after payment (starts with "/"). */
  returnPath?: string;
};

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as Body;
    const applicationId = body.applicationId?.trim();
    if (!applicationId) return NextResponse.json({ error: "applicationId is required." }, { status: 400 });

    const rawPackageSlug = body.packageSlug ?? "";
    const packageSlug: CheckrPackage = isCheckrPackage(rawPackageSlug) ? rawPackageSlug : "essential";
    const addOnProducts = (body.addOnProducts ?? []).filter(isCheckrAddOn) as CheckrAddOnSlug[];

    const db = createSupabaseServiceRoleClient();
    const admin = await isAdminUser(user.id);
    const { data: record } = await db
      .from("manager_application_records")
      .select("manager_user_id, property_id, assigned_property_id, row_data")
      .eq("id", applicationId)
      .maybeSingle();

    const managerUserId =
      record?.manager_user_id?.trim() ||
      (record?.row_data as { managerUserId?: string } | null)?.managerUserId?.trim();
    if (!managerUserId) {
      return NextResponse.json({ error: "Application has no assigned manager." }, { status: 400 });
    }
    if (!admin && managerUserId !== user.id) {
      const linked = await collectLinkedPropertyIdsForUser(db, user.id);
      const propertyId = String(record?.property_id ?? "").trim();
      const assignedPropertyId = String(record?.assigned_property_id ?? "").trim();
      if (!((propertyId && linked.has(propertyId)) || (assignedPropertyId && linked.has(assignedPropertyId)))) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    }

    const precheck = await precheckBackgroundCheckOrder({ db, applicationId, managerUserId });
    if (!precheck.ok) {
      return NextResponse.json({ error: precheck.error, code: precheck.code }, { status: precheck.status });
    }

    // Simulate-only environments have nothing to charge — run immediately.
    if (checkrSkipsManagerCardCharge()) {
      const result = await runBackgroundCheck({ db, applicationId, managerUserId, packageSlug, addOnProducts });
      if (!result.ok) {
        return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
      }
      track("background_check_started", managerUserId, { provider: "checkr", simulated: true });
      return NextResponse.json({ ok: true, ran: true, backgroundCheck: result.backgroundCheck });
    }

    const totalCents = checkrOrderCostCents(packageSlug, addOnProducts);

    const lineItems = [
      {
        price_data: {
          currency: "usd" as const,
          product_data: {
            name: buildScreeningCheckoutProductName(packageSlug, addOnProducts),
            description: screeningCheckoutDescription(packageSlug, addOnProducts),
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      },
    ];

    const metadata: Record<string, string> = {
      purpose: SCREENING_CHECKOUT_PURPOSE,
      application_id: applicationId,
      manager_user_id: managerUserId,
      package_slug: packageSlug,
      add_on_products: addOnProducts.join(","),
    };

    const { stripeCustomerId } = await getManagerPurchaseSku(managerUserId);
    const origin = resolveAppOrigin(req);
    const stripe = getStripe();
    const mode = body.mode === "embedded" ? "embedded" : "hosted";
    const sessionBase = {
      mode: "payment" as const,
      payment_method_types: ["card" as const],
      ...(stripeCustomerId ? { customer: stripeCustomerId } : { customer_email: user.email ?? undefined }),
      line_items: lineItems,
      metadata,
      payment_intent_data: { metadata },
      client_reference_id: managerUserId,
    };

    if (mode === "embedded") {
      const returnPath = body.returnPath?.trim();
      if (!returnPath?.startsWith("/")) {
        return NextResponse.json({ error: "returnPath is required for embedded checkout." }, { status: 400 });
      }
      const separator = returnPath.includes("?") ? "&" : "?";
      const session = await stripe.checkout.sessions.create({
        ui_mode: "embedded_page",
        ...sessionBase,
        return_url: `${origin}${returnPath}${separator}screening=return&session_id={CHECKOUT_SESSION_ID}`,
      });
      if (!session.client_secret) {
        return NextResponse.json({ error: "Stripe did not return a client secret." }, { status: 502 });
      }
      return NextResponse.json({ ok: true, mode: "embedded", clientSecret: session.client_secret, totalCents });
    }

    const session = await stripe.checkout.sessions.create({
      ...sessionBase,
      success_url: `${origin}/portal/applications?screening=paid&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/portal/applications?screening=cancelled`,
    });
    if (!session.url) {
      return NextResponse.json({ error: "Stripe did not return a checkout URL." }, { status: 502 });
    }

    return NextResponse.json({ ok: true, mode: "hosted", url: session.url, totalCents });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to start screening checkout.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
