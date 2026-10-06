import { NextResponse } from "next/server";
import { createClaimedApplicationFeeCheckout } from "@/lib/application-fee-payment-claim.server";
import { resolveAppOrigin } from "@/lib/app-url";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { isResidentSetupTokenValid } from "@/lib/auth/resident-setup-token";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { applicationRentalTypeFor } from "@/lib/rental-application/lease-terms";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { stripeNotConfiguredError } from "@/lib/stripe-axis-ach-checkout";

export const runtime = "nodejs";

type Body = {
  applicationId?: string;
  setupToken?: string;
  propertyId?: string;
  residentEmail?: string;
  residentName?: string;
  /** Listing owner Supabase user id (matches `profiles.id` / `MockProperty.managerUserId`). */
  managerUserId?: string;
  rentalType?: "standard" | "short_term";
  /** The applicant's lease type — picks the listing's per-type fee when it set one. */
  leaseTerm?: string;
  /** The applicant's first room choice - a selector into the listing's stored rooms. The fee is the room's fee for the lease type; an amount is never read from the body. */
  roomChoice1?: string;
  /** The bundle applied for - a selector into the listing's stored bundles; the fee is the bundle's, never read from the body. */
  bundleId?: string;
  /** P003: the application template the applicant is actually applying with — a selector into the listing's own stored templates, never an amount. */
  applicationTemplateId?: string;
  /** Checkout return path (defaults to public apply). Must start with `/`. */
  returnPath?: string;
  /**
   * `embedded` (default) renders the card form INLINE in the application;
   * `hosted` redirects to Stripe. Kept configurable so the wizard can request
   * inline while any legacy caller can still opt into a redirect.
   */
  mode?: "embedded" | "hosted";
};

/**
 * Creates a Stripe Checkout Session (card / Apple Pay / Google Pay) with
 * Connect destination charges for the rental application fee when Axis
 * payments are enabled on the listing. This charges the application fee only
 * — the holding/security deposit is never collected here; it is charged
 * under Payments after approval. A waived fee (manager waiver code) never
 * reaches this route at all — see `/api/public/application-fee-waiver`.
 */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`application-fee-checkout:${clientIpFrom(req)}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json()) as Body;
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
    const residentEmail = typeof body.residentEmail === "string" ? body.residentEmail.trim() : "";
    const managerUserId = typeof body.managerUserId === "string" ? body.managerUserId.trim() : "";

    if (!applicationId || !propertyId || !residentEmail.includes("@") || !managerUserId) {
      return NextResponse.json({ error: "Save your application before starting payment." }, { status: 400 });
    }
    if (body.mode === "hosted") {
      return NextResponse.json({ error: "Open payment inside your application." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const { data: application, error: applicationError } = await db.from("manager_application_records")
      .select("id,manager_user_id,property_id,resident_email,row_data,updated_at")
      .eq("id", applicationId).maybeSingle();
    if (applicationError) throw new Error(applicationError.message);
    if (!application || !isDraftShapedApplicationRow(application.row_data ?? {}) ||
        isWithdrawnApplicationRow(application.row_data ?? {})) {
      return NextResponse.json({ code: "APPLICATION_DRAFT_PENDING", error: "Your application is still saving. Try payment again shortly." }, { status: 409 });
    }
    if (application.manager_user_id !== managerUserId || application.property_id !== propertyId ||
        String(application.resident_email ?? "").trim().toLowerCase() !== residentEmail.toLowerCase()) {
      return NextResponse.json({ error: "This payment does not match your saved application." }, { status: 403 });
    }
    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    let authorized = false;
    if (user?.email?.trim().toLowerCase() === residentEmail.toLowerCase()) {
      const { data: profile, error: profileError } = await db.from("profiles")
        .select("role").eq("id", user.id).maybeSingle();
      if (profileError) throw new Error(profileError.message);
      authorized = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
    }
    if (!authorized && typeof body.setupToken === "string") {
      authorized = isResidentSetupTokenValid(application.row_data ?? {}, body.setupToken);
    }
    if (!authorized) return NextResponse.json({ error: "Application access required before payment." }, { status: 403 });
    let savedApplication: DemoApplicantRow["application"];
    try {
      savedApplication = openApplicantRow(application.row_data as DemoApplicantRow, application.id).application;
    } catch {
      return NextResponse.json({ error: "Your saved application could not be read. Try again." }, { status: 409 });
    }
    if (!savedApplication) {
      return NextResponse.json({ code: "APPLICATION_DRAFT_PENDING", error: "Your application is still saving. Try payment again shortly." }, { status: 409 });
    }

    const stripe = getStripe();
    const appUrl = resolveAppOrigin(req);
    const returnPath =
      typeof body.returnPath === "string" && body.returnPath.startsWith("/")
        ? body.returnPath.split("?")[0] ?? "/rent/apply"
        : "/rent/apply";
    const mode = "embedded" as const;

    // Stamp propertyId on the return URL so the wizard can re-bind the listing
    // after embedded Checkout (PRP-427). Checkout used to drop every query
    // param, so a successful pay landed on bare /rent/apply and the manager-link
    // gate fired once finalize cleared the in-memory form.
    // Keep `{CHECKOUT_SESSION_ID}` literal (not URLSearchParams) so Stripe can
    // substitute it — encoding the braces breaks the placeholder.
    const pidQ = encodeURIComponent(propertyId);
    const result = await createClaimedApplicationFeeCheckout(db, stripe, {
      applicationId,
      draftUpdatedAt: application.updated_at,
      propertyId,
      residentEmail,
      residentName: savedApplication.fullLegalName?.trim() || undefined,
      managerUserId: String(application.manager_user_id),
      rentalType: applicationRentalTypeFor(savedApplication.rentalType),
      leaseTerm: savedApplication.leaseTerm?.slice(0, 40) || undefined,
      roomChoice1: savedApplication.roomChoice1?.slice(0, 200) || undefined,
      bundleId: (savedApplication as { bundleId?: string }).bundleId?.slice(0, 200) || undefined,
      applicationTemplateId: savedApplication.applicationTemplateId?.slice(0, 80) || undefined,
      mode,
      // Embedded returns the applicant to the same apply step after paying; the
      // wizard verifies the session server-side before treating the fee as paid.
      returnUrl: `${appUrl}${returnPath}?propertyId=${pidQ}&fee_checkout=return&session_id={CHECKOUT_SESSION_ID}`,
      successUrl: `${appUrl}${returnPath}?propertyId=${pidQ}&fee_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}${returnPath}?propertyId=${pidQ}&fee_checkout=cancel`,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    }

    return NextResponse.json({
      // `clientSecret` drives the inline embedded form; `url` is present only on
      // the legacy hosted path. Itemized so the caller shows "application fee +
      // service fee = total" before paying — never a surprise amount.
      mode: "embedded",
      clientSecret: result.clientSecret,
      sessionId: result.sessionId,
      applicationFeeCents: result.itemization.applicationFeeCents,
      serviceFeeCents: result.itemization.serviceFeeCents,
      totalCents: result.itemization.totalCents,
      platformFeeCents: 0,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Checkout failed";
    if (stripeNotConfiguredError(message)) {
      return NextResponse.json(
        { code: "STRIPE_NOT_CONFIGURED", error: "Stripe is not configured on the server (missing STRIPE_SECRET_KEY)." },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
