import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { allowLinkRequest, expiredLinkResponse } from "@/lib/one-number/link-http.server";
import { resolveLinkDestination } from "@/lib/one-number/link-destinations.server";
import { linkSessionCookieName, resolvePhoneBoundLink, verifyLinkSession } from "@/lib/one-number/links.server";
import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Start the IN-PAGE payment form (Stripe embedded checkout: card, Apple Pay, Google Pay) for the charge(s) a rent link names.
 * The person never leaves /l/<token>; there is no redirect to a hosted payment page. Same checkout core the resident's own
 * Payments page and the agent use (`createHouseholdChargeCheckout`): ownership, not-already-paid,
 * fee payer, the claim that stops a double debit, and the metadata the webhook reads (charge ids,
 * resident email, manager id) all come from it. This route adds only the proof that the caller
 * holds the phone: a live verified session on THIS link, plus a destination re-derived from the
 * live charge rows. Nothing about who pays or what is owed comes from the request.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!(await allowLinkRequest(req, token, "rent", 20, 10))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const db = createSupabaseServiceRoleClient();
  const resolved = await resolvePhoneBoundLink(db, token, { count: false });
  if (!resolved || resolved.link.purpose !== "rent") return expiredLinkResponse();
  const { link } = resolved;

  const jar = await cookies();
  const verified = await verifyLinkSession(db, link, jar.get(linkSessionCookieName(token))?.value);
  if (!verified) {
    return NextResponse.json({ error: "Enter the code we texted you first.", needsCode: true }, { status: 401, headers: NO_STORE });
  }

  const destination = await resolveLinkDestination(db, link);
  if (destination.kind !== "rent") return expiredLinkResponse();

  const result = await createHouseholdChargeCheckout(db, {
    userId: destination.residentUserId,
    userEmail: destination.residentEmail,
    chargeIds: destination.chargeIds,
    mode: "embedded",
    paymentMethod: "card",
    appOrigin: resolveAppOrigin(req),
    returnPath: `/l/${encodeURIComponent(token)}`,
  });
  if (!result.ok || result.mode !== "embedded") {
    // A bank debit needs the in-app form; say where, not why a card could not start.
    const needsApp = !result.ok && (result.code === "PAYMENT_METHOD_DISABLED" || result.code === "IN_APP_BANK_PAYMENT");
    return NextResponse.json(
      {
        error: needsApp
          ? "Card is not accepted for this charge. Sign in to PropLane to pay by bank."
          : result.ok || result.status >= 500
            ? "Checkout could not start. Try again soon."
            : result.error,
        signInHref: needsApp ? "/auth/sign-in?next=%2Fresident%2Fpayments" : undefined,
      },
      { status: result.ok ? 502 : result.status, headers: NO_STORE },
    );
  }
  return NextResponse.json({ clientSecret: result.clientSecret }, { headers: NO_STORE });
}
