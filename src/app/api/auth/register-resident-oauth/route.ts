import { recoverySetupRedirect } from "@/lib/auth/account-recovery.server";
import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import {
  completeProspectHandoffForUser,
  prospectHandoffSuccessResponse,
} from "@/lib/auth/complete-prospect-handoff.server";
import {
  consumeResidentSetupTokenOnApplication,
  findApplicationForResidentSetup,
  relinkResidentSetupApplicationEmail,
} from "@/lib/auth/resident-setup-token";
import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";
import { scheduleResidentSetupLinkEmail } from "@/lib/auth/schedule-resident-setup-link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  axisId?: string;
  token?: string;
  tourInquiryId?: string;
  handoff?: string;
  fullName?: string;
  phone?: string;
  email?: string;
  nextPath?: string;
};

function oauthFullName(meta: Record<string, unknown> | null | undefined): string | undefined {
  const fullName = typeof meta?.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta?.name === "string" ? meta.name.trim() : "";
  return name || undefined;
}

/**
 * Complete resident OAuth signup.
 *
 * Two paths, same default-deny contract as the email/password
 * `resident-register` route:
 *  - WITH a setup token + axis id (the emailed handoff, or a re-inheritance
 *    attempt): the token proves control of the applicant's email, so this
 *    inherits the matching application's identity/approval.
 *  - WITHOUT one — a brand-new "Continue with Google/Apple" signup with no
 *    prior application, first-class exactly like the email/password form:
 *    mints a CLEAN resident profile (no inheritance, no PII copy) and emails
 *    the setup link so a genuine later re-inheritance is still possible,
 *    gated on that link — never on the OAuth provider alone, which proves
 *    control of THIS email but not of whatever email a prior guest
 *    application might be filed under.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const axisId = typeof body.axisId === "string" ? body.axisId.trim() : "";
    const tourInquiryId = typeof body.tourInquiryId === "string" ? body.tourInquiryId.trim() : "";
    const handoff = typeof body.handoff === "string" ? body.handoff.trim() : "";
    const prospectFullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const prospectPhone = typeof body.phone === "string" ? body.phone.trim() : "";
    const prospectEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const prospectNextPath = typeof body.nextPath === "string" ? body.nextPath.trim() : "";

    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();

    if (!user?.id || !user.email) {
      return NextResponse.json({ error: "Sign in with Google or Apple first." }, { status: 401 });
    }

    const service = createSupabaseServiceRoleClient();
    const recovery = await recoverySetupRedirect(service, user.id);
    if (recovery) return NextResponse.json({ ok: true, recoveryRequired: true, redirectTo: recovery });
    const oauthEmail = user.email.trim().toLowerCase();

    if ((tourInquiryId || handoff === "message") && !token && !axisId) {
      const contactEmail =
        handoff === "message"
          ? oauthEmail
          : prospectEmail.includes("@")
            ? prospectEmail
            : oauthEmail;
      const handoffResult = await completeProspectHandoffForUser(service, {
        userId: user.id,
        email: contactEmail,
        authEmail: oauthEmail,
        fullName: prospectFullName || oauthFullName(user.user_metadata),
        phone: prospectPhone,
        tourInquiryId: tourInquiryId || undefined,
        handoff: handoff === "message" ? "message" : undefined,
        nextPath: prospectNextPath || undefined,
      });
      if (!handoffResult.ok) {
        return NextResponse.json({ error: handoffResult.error }, { status: handoffResult.status });
      }

      track("resident_account_created", user.id, {
        source: tourInquiryId ? "tour_booking" : "property_message",
        ...(tourInquiryId ? { inquiry_id: tourInquiryId } : {}),
        oauth: true,
      });

      return prospectHandoffSuccessResponse(handoffResult.redirectTo);
    }

    if (!token || !axisId) {
      const fullName = oauthFullName(user.user_metadata);

      // DEFAULT-DENY: no setup token means this OAuth sign-in has not proven
      // control of a prior applicant's email, so it never inherits.
      const result = await provisionResidentAccountByEmail(service, {
        userId: user.id,
        email: oauthEmail,
        fullName,
        inheritFromApplication: false,
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }

      // Verification-gated re-inheritance, same as resident-register: if a
      // prior guest application exists for this email, email the one-time
      // setup link (the token proves control). Non-blocking so signup never
      // waits on the inbox round-trip.
      scheduleResidentSetupLinkEmail(oauthEmail);

      return NextResponse.json({
        ok: true,
        axisId: result.axisId,
        linkedApplication: result.linkedApplication,
        redirectTo: "/resident/applications",
      });
    }

    const lookup = await findApplicationForResidentSetup(service, { token, axisId });
    if (!lookup.ok) {
      return NextResponse.json({ error: lookup.error }, { status: lookup.status });
    }

    // A valid setup token already authorizes this handoff, so a Google email that
    // differs from the one on the application is not an error — the applicant just
    // chose a different Google account. Relink the application onto the account
    // they actually control instead of rejecting them.
    let applicationRow = lookup.row;
    if (oauthEmail !== lookup.email) {
      applicationRow = await relinkResidentSetupApplicationEmail(service, lookup.row, oauthEmail);
    }

    const fullName = oauthFullName(user.user_metadata) ?? lookup.name;

    const result = await provisionResidentAccountByEmail(service, {
      userId: user.id,
      email: oauthEmail,
      fullName,
      phone: lookup.phone,
      // OAuth + setup token authorize this flow — email control is proven, so
      // inherit the matching application's identity/approval (default-deny opt-in).
      inheritFromApplication: true,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    await service.from("profiles").update({ manager_id: lookup.axisId }).eq("id", user.id);
    await consumeResidentSetupTokenOnApplication(service, applicationRow);

    return NextResponse.json({
      ok: true,
      axisId: lookup.axisId,
      linkedApplication: true,
      relinkedEmail: oauthEmail !== lookup.email ? oauthEmail : undefined,
      redirectTo: "/resident/applications",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Signup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
