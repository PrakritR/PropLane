import { NextResponse } from "next/server";
import { resolveApplicationFeeItemization, resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { previewApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";
import { loadManagerApplicationSettings } from "@/lib/manager-application-settings";
import { shouldWaiveApplicationFeeForResidentServer } from "@/lib/rental-application/application-policy.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
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
  /** When present, resolves repeat-applicant fee waiver server-side. */
  residentEmail?: string;
  residentUserId?: string;
};

/**
 * Read-only itemization the applicant sees BEFORE paying: application fee,
 * any service fee they are bearing (plan-based), and the total. Creates no
 * Stripe object. Optionally previews a waiver code without redeeming it.
 */
export async function POST(req: Request) {
  try {
    if (!rateLimit(`application-fee-preview:${clientIpFrom(req)}`, 60, 60_000).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const body = (await req.json()) as Body;
    const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    const managerUserId = typeof body.managerUserId === "string" ? body.managerUserId.trim() : "";
    if (!propertyId || !managerUserId) {
      return NextResponse.json({ error: "propertyId and managerUserId are required." }, { status: 400 });
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

    const channel = body.channel === "manual" ? "manual" : "card";
    const itemization = await resolveApplicationFeeItemization(db, managerUserId, resolved.value.applicationFeeCents, channel);

    const managerSettings = await loadManagerApplicationSettings(db, managerUserId);

    const waiverCode = typeof body.waiverCode === "string" ? body.waiverCode.trim() : "";
    const waiver = waiverCode ? await previewApplicationFeeWaiverCode(db, managerUserId, waiverCode) : null;

    const residentEmail = typeof body.residentEmail === "string" ? body.residentEmail.trim() : "";
    let repeatApplicantFeeWaived: boolean | undefined;
    if (residentEmail.includes("@")) {
      repeatApplicantFeeWaived = await shouldWaiveApplicationFeeForResidentServer(db, {
        managerUserId,
        residentEmail,
        residentUserId: typeof body.residentUserId === "string" ? body.residentUserId : null,
        chargePolicy: managerSettings.applicationFeeChargePolicy,
      });
    }

    return NextResponse.json({
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
