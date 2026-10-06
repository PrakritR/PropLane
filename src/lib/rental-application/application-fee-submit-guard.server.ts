import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationFeeBasisFromSessionMetadata, applicationFeePaymentSatisfiesTemplate,
  resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { shouldWaiveApplicationFeeForResidentServer } from "@/lib/rental-application/application-policy.server";
import { applicationRentalTypeFor } from "@/lib/rental-application/lease-terms";
import { loadManagerApplicationSettings } from "@/lib/manager-application-settings";
import { resolveApplicationFeeChargePolicy } from "@/lib/rental-application/listing-application-fee-policy";

export type ApplicationFeeSubmitGuard =
  | { ok: true }
  | { ok: false; status: 409 | 500; error: string };

/** The applicant's submitted flag is not payment evidence. Resolve the fee
 * from the owned listing and require a waiver or this exact application's
 * settled provider claim before a new resident/guest submission is saved. */
export async function authorizeApplicationFeeSubmission(
  db: SupabaseClient,
  row: DemoApplicantRow,
): Promise<ApplicationFeeSubmitGuard> {
  const applicationId = row.id?.trim() ?? "";
  const propertyId = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  const claimedManagerId = row.managerUserId?.trim() ?? "";
  const email = (row.email?.trim() || row.application?.email?.trim() || "").toLowerCase();
  const answers = row.application;
  if (!applicationId || !propertyId || !email.includes("@") || !answers) {
    return { ok: false, status: 409, error: "Application fee source cannot be verified." };
  }
  try {
    const resolved = await resolveApplicationFeeProperty(db, {
      propertyId, managerUserId: claimedManagerId,
      applicationTemplateId: answers.applicationTemplateId,
      roomChoice1: answers.roomChoice1,
      bundleId: (answers as { bundleId?: string }).bundleId,
      leaseTerm: answers.leaseTerm,
      rentalType: applicationRentalTypeFor(answers.rentalType),
    }, { allowZeroFee: true });
    if (!resolved.ok || (claimedManagerId && resolved.value.managerUserId !== claimedManagerId)) {
      return { ok: false, status: 500, error: "Could not verify the listing's application fee." };
    }
    const managerId = resolved.value.managerUserId;
    if (resolved.value.applicationFeeCents <= 0) return { ok: true };
    const settings = await loadManagerApplicationSettings(db, managerId);
    const chargePolicy = resolveApplicationFeeChargePolicy(
      resolved.value.listing, settings.applicationFeeChargePolicy);
    if (await shouldWaiveApplicationFeeForResidentServer(db, {
      managerUserId: managerId, residentEmail: email,
      residentUserId: row.residentUserId ?? null,
      chargePolicy,
    })) return { ok: true };

    if (answers.applicationFeeWaived) {
      const { data: redemptions, error } = await db.from("application_fee_waiver_redemptions")
        .select("id").eq("manager_user_id", managerId).eq("property_id", propertyId)
        .eq("resident_email", email).eq("application_id", applicationId)
        .eq("kind", "application").limit(1);
      if (error) throw error;
      if (redemptions?.length === 1) return { ok: true };
    }

    const { data: claim, error: claimError } = await db.from("application_fee_payment_claims")
      .select("application_id,manager_user_id,property_id,resident_email,charge_id,status,stripe_session_id,principal_cents,provider_params")
      .eq("application_id", applicationId).maybeSingle();
    if (claimError) throw claimError;
    if (!claim || claim.status !== "settled" || !claim.stripe_session_id ||
        claim.manager_user_id !== managerId || claim.property_id !== propertyId ||
        claim.resident_email !== email) {
      return { ok: false, status: 409, error: "Pay this application's fee before submitting." };
    }
    const quote = claim.provider_params as { metadata?: Record<string, string> } | null;
    if (!quote?.metadata || !applicationFeePaymentSatisfiesTemplate({
      submittedApplicationTemplateId: answers.applicationTemplateId?.trim() || null,
      paidApplicationTemplateId: quote.metadata.application_template_id?.trim() || null,
      paidFeeCents: claim.principal_cents,
      requiredFeeCents: resolved.value.applicationFeeCents,
      paidFeeBasis: applicationFeeBasisFromSessionMetadata(quote.metadata),
      submittedFeeBasis: {
        roomId: resolved.value.feeRoomId ?? "",
        leaseTerm: resolved.value.feeLeaseTerm,
        bundleId: String((answers as { bundleId?: string }).bundleId ?? "").trim(),
        rentalType: applicationRentalTypeFor(answers.rentalType),
      },
    })) {
      return { ok: false, status: 409, error: "This application changed after its fee was paid." };
    }
    const { data: charge, error: chargeError } = await db.from("portal_household_charge_records")
      .select("id,manager_user_id,resident_email,property_id,kind,status,row_data")
      .eq("id", claim.charge_id).maybeSingle();
    if (chargeError) throw chargeError;
    const paid = charge?.row_data as { applicationId?: string; stripeCheckoutSessionId?: string } | null;
    if (!charge || charge.manager_user_id !== managerId || charge.property_id !== propertyId ||
        charge.resident_email?.trim().toLowerCase() !== email || charge.kind !== "application_fee" ||
        charge.status !== "paid" || paid?.applicationId !== applicationId ||
        paid.stripeCheckoutSessionId !== claim.stripe_session_id) {
      return { ok: false, status: 409, error: "This application's fee has not settled." };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 500, error: "Could not verify the application fee. Try again." };
  }
}
