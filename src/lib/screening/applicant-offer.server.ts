import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { applicationIdentityVerified } from "@/lib/checkr/identity";
import { backgroundCheckConfigured } from "@/lib/checkr/config";
import { applicantIdCheckAvailable } from "@/lib/resident-identity/provider";
import {
  FCRA_AUTHORIZATION_LABEL,
  FCRA_DISCLOSURE_TEXT,
  FCRA_DISCLOSURE_VERSION,
  resolveApplicantScreeningOffer,
  type ApplicantScreeningOffer,
  type ApplicantScreeningView,
} from "@/lib/screening/applicant-screening";
import { resolveApplicantScreeningSettings } from "@/lib/screening/applicant-screening-settings.server";
import type { ApplicantScreeningContext } from "@/lib/screening/applicant-screening-access.server";

/** One read for the quote route and the checkout route, so the card and the charge cannot disagree. */
export async function resolveApplicantScreeningView(
  db: SupabaseClient,
  ctx: Extract<ApplicantScreeningContext, { ok: true }>,
): Promise<ApplicantScreeningView> {
  const { settings } = await resolveApplicantScreeningSettings(db, {
    managerUserId: ctx.managerUserId,
    propertyId: ctx.propertyId,
  });
  const existing = ctx.row.backgroundCheck;
  const offer: ApplicantScreeningOffer = existing
    ? { kind: "none" }
    : resolveApplicantScreeningOffer({
        settings,
        idCheckAvailable: applicantIdCheckAvailable(),
        backgroundCheckConfigured: backgroundCheckConfigured(),
      });
  return {
    offer,
    disclosure: {
      version: FCRA_DISCLOSURE_VERSION,
      text: FCRA_DISCLOSURE_TEXT,
      authorizationLabel: FCRA_AUTHORIZATION_LABEL,
    },
    check: existing ? { status: existing.status, idVerified: applicationIdentityVerified(existing) } : null,
  };
}
