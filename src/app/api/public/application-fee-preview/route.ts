import { NextResponse } from "next/server";
import { resolveApplicationFeeItemization, resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { previewApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";
import { loadManagerApplicationSettings } from "@/lib/manager-application-settings";
import { shouldWaiveApplicationFeeForResidentServer } from "@/lib/rental-application/application-policy.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  propertyId?: string;
  managerUserId?: string;
  /** Long-term vs short-term application — picks the listing's fee field. */
  rentalType?: "standard" | "short_term";
  /** Optional — when present, also reports whether the code currently looks redeemable. */
  waiverCode?: string;
  /** "manual" (Zelle/Venmo/other) never carries a Stripe service fee; defaults to "card". */
  channel?: "card" | "manual";
  /**
   * Only honored for a signed-in caller whose own session email matches it —
   * the repeat-applicant waiver reveals that this address has applied to this
   * manager before, which an anonymous caller must never be able to probe.
   */
  residentEmail?: string;
};

/** The signed-in caller, or null when the request carries no session. */
async function sessionApplicant(): Promise<{ email: string; userId: string } | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const email = user?.email?.trim().toLowerCase() ?? "";
    if (!user?.id || !email) return null;
    return { email, userId: user.id };
  } catch {
    return null;
  }
}

/**
 * Read-only itemization the applicant sees BEFORE paying: application fee,
 * any service fee they are bearing (plan-based), and the total. Creates no
 * Stripe object. Optionally previews a waiver code without redeeming it.
 */
export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`application-fee-preview:${clientIpFrom(req)}`, 60, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json()) as Body;
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    const managerUserId = typeof body.managerUserId === "string" ? body.managerUserId.trim() : "";
    if (!propertyId) {
      return NextResponse.json({ error: "propertyId is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    // A 0 effective fee is a normal "applications are free" answer here — the
    // wizard passes the applicant through with no payment step. Only the
    // checkout mint treats 0 as an error, and it is never called for a 0 fee.
    const resolved = await resolveApplicationFeeProperty(
      db,
      {
        propertyId,
        managerUserId,
        rentalType: body.rentalType === "short_term" ? "short_term" : "standard",
      },
      { allowZeroFee: true },
    );
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    }

    const ownerUserId = resolved.value.managerUserId;
    const channel = body.channel === "manual" ? "manual" : "card";
    const itemization = await resolveApplicationFeeItemization(db, ownerUserId, resolved.value.applicationFeeCents, channel);

    const managerSettings = await loadManagerApplicationSettings(db, ownerUserId);

    const waiverCode = typeof body.waiverCode === "string" ? body.waiverCode.trim() : "";
    const waiver = waiverCode ? await previewApplicationFeeWaiverCode(db, ownerUserId, waiverCode) : null;

    const residentEmail = typeof body.residentEmail === "string" ? body.residentEmail.trim().toLowerCase() : "";
    let repeatApplicantFeeWaived: boolean | undefined;
    if (residentEmail.includes("@")) {
      const applicant = await sessionApplicant();
      if (applicant && applicant.email === residentEmail) {
        repeatApplicantFeeWaived = await shouldWaiveApplicationFeeForResidentServer(db, {
          managerUserId: ownerUserId,
          residentEmail: applicant.email,
          residentUserId: applicant.userId,
          chargePolicy: managerSettings.applicationFeeChargePolicy,
        });
      }
    }

    return NextResponse.json({
      managerUserId: resolved.value.managerUserId,
      applicationFeeCents: itemization.applicationFeeCents,
      serviceFeeCents: itemization.serviceFeeCents,
      totalCents: itemization.totalCents,
      feePayer: itemization.feePayer,
      chargePolicy: managerSettings.applicationFeeChargePolicy,
      repeatApplicantFeeWaived,
      applicationFeeOtherEnabled: managerSettings.applicationFeeOtherEnabled,
      applicationFeeOtherInstructions: managerSettings.applicationFeeOtherEnabled
        ? managerSettings.applicationFeeOtherInstructions
        : "",
      waiver: waiver ? { valid: waiver.ok, error: waiver.ok ? undefined : waiver.error } : undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load application fee.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
