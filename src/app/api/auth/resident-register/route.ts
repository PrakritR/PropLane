import { recoverySetupRedirect } from "@/lib/auth/account-recovery.server";
import { NextResponse } from "next/server";
import { normalizeE164 } from "@/lib/twilio";
import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";
import { scheduleResidentSetupLinkEmail } from "@/lib/auth/schedule-resident-setup-link";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type Body = {
  email?: string;
  password?: string;
  fullName?: string;
  phone?: string;
};

/**
 * Prospective-resident self-serve signup: a renter creates a resident account and
 * then applies from inside their portal. The emailed setup link remains the
 * fallback for guests who applied without an account.
 *
 * Safety: this only ever mints a `resident` account. `provisionResidentAccountByEmail`
 * sets `application_approved` from a MATCHING application (false for a brand-new
 * applicant with no application), so signing up never approves anyone or grants an
 * elevated role — the manager still approves the application. All writes go through
 * the service-role client, never the client-writable `profiles` surface.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const phone = normalizeE164(typeof body.phone === "string" ? body.phone : "");

    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!phone) {
      return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
    }

    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user?.email_confirmed_at || user.email?.trim().toLowerCase() !== email) {
      return NextResponse.json({ error: "Verify your email and sign in before completing account setup.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
    }
    const supabase = createSupabaseServiceRoleClient();

    const userId = user.id;

    const recovery = await recoverySetupRedirect(supabase, userId);
    if (recovery) return NextResponse.json({ ok: true, existingAccount: true, recoveryRequired: true, redirectTo: recovery });

    // DEFAULT-DENY: a self-serve signup has NOT proven control of this email, so
    // it never inherits or claims a prior guest application — it mints a clean
    // resident profile (application_approved=false, no application PII).
    const provisioned = await provisionResidentAccountByEmail(supabase, {
      userId,
      email,
      fullName,
      phone,
      emailProven: true,
      inheritFromApplication: false,
    });
    if (!provisioned.ok) {
      return NextResponse.json({ error: provisioned.error }, { status: provisioned.status });
    }

    // Verification-gated re-inheritance: if a prior guest application exists for
    // this email, email the one-time setup link (the token proves control). Only
    // using that link links/inherits the application — signup itself never does.
    // Non-blocking so the smooth create-account → apply flow is not held on the
    // inbox round-trip. The setup-link route is neutral + rate-limited and never
    // returns the token to the browser.
    scheduleResidentSetupLinkEmail(email);

    return NextResponse.json({
      ok: true,
      axisId: provisioned.axisId,
      linkedApplication: provisioned.linkedApplication,
      // Default landing; the client redirects to a `next` (in-portal apply) when present.
      redirectTo: "/resident/applications",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create resident account.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
