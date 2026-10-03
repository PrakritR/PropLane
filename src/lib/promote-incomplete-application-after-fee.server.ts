/**
 * PRP-431 — when Stripe collects the application fee, promote the matching
 * Incomplete (in-progress) application to Submitted using the draft snapshot
 * already on the server. Does not invent answers; fails closed when validation
 * would refuse a normal guest submit.
 */
import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  notifyManagerApplicationSubmitted,
  shouldNotifyManagerOfApplicationSubmit,
} from "@/lib/application-submitted-notification.server";
import { dispatchMoveInFormsForResidencyAfterResponse } from "@/lib/move-in-forms/server";
import { prepareGuestApplicationUpsert } from "@/lib/auth/guest-application-upsert";
import { applicationRentalTypeFor } from "@/lib/rental-application/lease-terms";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { openApplicantRow, prepareApplicantIdentityWrite, sealApplicantRow } from "@/lib/security/applicant-identity";
import {
  isApplicationFeeCheckoutSession,
} from "@/lib/stripe-application-fee";
import { axisAchCheckoutPaid } from "@/lib/stripe-axis-ach-checkout";
import { bestEffortFailed } from "@/lib/observability/best-effort";
import {
  applicationFeePaymentSatisfiesTemplate,
  resolveRequiredApplicationFeeCents,
} from "@/lib/application-fee-checkout.server";

function normalizedEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function propertyIdFromRow(row: DemoApplicantRow): string {
  return (
    row.assignedPropertyId?.trim() ||
    row.propertyId?.trim() ||
    row.application?.propertyId?.trim() ||
    ""
  );
}

function matchesProperty(row: DemoApplicantRow, propertyId: string, dbPropertyId?: string | null, dbAssigned?: string | null): boolean {
  const pid =
    String(dbAssigned ?? "").trim() ||
    String(dbPropertyId ?? "").trim() ||
    propertyIdFromRow(row);
  return pid.toLowerCase() === propertyId.toLowerCase();
}

export type PromoteIncompleteAfterFeeResult =
  | { ok: true; promoted: true; axisId: string; setupToken?: string }
  | {
      ok: true;
      promoted: false;
      reason: "already_submitted" | "no_draft" | "validation_failed" | "not_paid";
      axisId?: string;
    }
  | {
      ok: true;
      promoted: false;
      /**
       * Lead review follow-up (2026-09-27): the draft's CURRENT application
       * template differs from what the Stripe session actually paid for, and
       * the amount paid does not cover what the current template requires —
       * e.g. paid for a $0 template, then switched to a paid one before this
       * ran. Never promoted; the applicant owes the difference.
       */
      reason: "fee_mismatch";
      requiredCents: number;
      paidCents: number;
    }
  | { ok: false; error: string };

/**
 * Find Incomplete draft for this Stripe fee session and promote it to Submitted.
 * Idempotent: if a Submitted row already exists for email+property, returns
 * `already_submitted` without rewriting.
 */
export async function promoteIncompleteApplicationAfterFeePaid(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<PromoteIncompleteAfterFeeResult> {
  if (!isApplicationFeeCheckoutSession(session) || !axisAchCheckoutPaid(session)) {
    return { ok: true, promoted: false, reason: "not_paid" };
  }

  const propertyId = session.metadata?.property_id?.trim() ?? "";
  const residentEmail = normalizedEmail(session.metadata?.resident_email ?? session.customer_email);
  if (!propertyId || !residentEmail.includes("@")) {
    return { ok: false, error: "Checkout session is missing applicant or listing metadata." };
  }

  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data, manager_user_id, property_id, assigned_property_id, resident_email")
    .eq("resident_email", residentEmail)
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) {
    return { ok: false, error: error.message };
  }

  type Stored = {
    id: string;
    row_data: DemoApplicantRow | null;
    manager_user_id: string | null;
    property_id: string | null;
    assigned_property_id: string | null;
  };

  const rows = (data ?? []) as Stored[];
  let alreadySubmitted: DemoApplicantRow | null = null;
  let draft: { record: Stored; row: DemoApplicantRow } | null = null;

  for (const record of rows) {
    const app = (record.row_data ?? {}) as DemoApplicantRow;
    if (isWithdrawnApplicationRow(app)) continue;
    if (!matchesProperty(app, propertyId, record.property_id, record.assigned_property_id)) continue;
    if (isDraftShapedApplicationRow(app)) {
      if (!draft) draft = { record, row: { ...app, id: record.id } };
      continue;
    }
    alreadySubmitted = { ...app, id: record.id };
    break;
  }

  if (alreadySubmitted) {
    return {
      ok: true,
      promoted: false,
      reason: "already_submitted",
      axisId: alreadySubmitted.id,
    };
  }
  if (!draft?.row.application) {
    return { ok: true, promoted: false, reason: "no_draft" };
  }

  // Stored row_data is sealed: ssn / dateOfBirth / driversLicense live only in
  // the ciphertext. Validating it sealed failed every paid guest application,
  // and re-sealing it would have written those answers back as blanks.
  let previousRow: DemoApplicantRow;
  try {
    previousRow = { ...openApplicantRow(draft.record.row_data, draft.record.id), id: draft.record.id };
  } catch {
    return { ok: false, error: "The saved application could not be read." };
  }
  const previousApplication = previousRow.application;
  if (!previousApplication) {
    return { ok: true, promoted: false, reason: "no_draft" };
  }

  // Lead review follow-up (2026-09-27): re-resolve the fee for the template
  // this draft is ACTUALLY about to submit under — never trust that the paid
  // session's template still matches. `submitted === paid` (including both
  // "no template", the single-template/no-override case) is always fine;
  // otherwise the paid amount must cover what the current template requires.
  const paidApplicationTemplateId = session.metadata?.application_template_id?.trim() || null;
  const paidFeeCents = Number(session.metadata?.fee_cents ?? "0");
  const submittedApplicationTemplateId = previousApplication.applicationTemplateId?.trim() || null;
  if (submittedApplicationTemplateId !== paidApplicationTemplateId) {
    const requiredCents = await resolveRequiredApplicationFeeCents(db, {
      propertyId,
      managerUserId: draft.record.manager_user_id?.trim() || "",
      applicationTemplateId: submittedApplicationTemplateId,
      roomChoice1: previousApplication.roomChoice1,
      leaseTerm: previousApplication.leaseTerm,
      rentalType: applicationRentalTypeFor(previousApplication.rentalType),
    });
    if (
      !applicationFeePaymentSatisfiesTemplate({
        submittedApplicationTemplateId,
        paidApplicationTemplateId,
        paidFeeCents: Number.isFinite(paidFeeCents) ? paidFeeCents : 0,
        requiredFeeCents: requiredCents,
      })
    ) {
      return {
        ok: true,
        promoted: false,
        reason: "fee_mismatch",
        requiredCents,
        paidCents: Number.isFinite(paidFeeCents) ? paidFeeCents : 0,
      };
    }
  }

  const applicantName =
    previousRow.name?.trim() ||
    previousApplication.fullLegalName?.trim() ||
    session.metadata?.resident_name?.trim() ||
    "Applicant";

  const submittedRow: DemoApplicantRow = {
    ...previousRow,
    id: previousRow.id,
    name: applicantName,
    email: residentEmail,
    property:
      previousRow.property?.trim() ||
      previousApplication.propertyId?.trim() ||
      propertyId,
    propertyId,
    stage: "Submitted",
    bucket: "pending",
    backgroundCheckStatus: previousRow.backgroundCheckStatus ?? "pending_review",
    detail: `Submitted ${new Date().toLocaleString()}`,
    application: {
      ...createInitialRentalWizardState(),
      ...previousApplication,
      email: residentEmail,
      propertyId,
      fullLegalName: previousApplication.fullLegalName?.trim() || applicantName,
    },
  };

  const prepared = await prepareGuestApplicationUpsert(db, {
    row: submittedRow,
    existing: previousRow,
  });
  if (!prepared.ok) {
    // The fee is already collected, so a refusal here is never silent. Field
    // names only: the answers themselves may be identity data.
    console.warn("[application-fee-promote] refused", {
      applicationId: draft.record.id,
      status: prepared.status,
      fields: Object.keys(prepared.fieldErrors ?? {}),
    });
    return { ok: true, promoted: false, reason: "validation_failed" };
  }

  const row = prepareApplicantIdentityWrite(prepared.row, previousRow, draft.record.id);
  const values = {
    id: row.id,
    manager_user_id: row.managerUserId || draft.record.manager_user_id || null,
    resident_email: residentEmail,
    property_id: row.propertyId || propertyId,
    assigned_property_id: row.assignedPropertyId || null,
    row_data: sealApplicantRow(row, row.id, draft.record.manager_user_id || row.managerUserId),
    updated_at: new Date().toISOString(),
  };

  const { error: upsertError } = await db
    .from("manager_application_records")
    .upsert(values, { onConflict: "id" });
  if (upsertError) {
    return { ok: false, error: upsertError.message };
  }

  if (shouldNotifyManagerOfApplicationSubmit(previousRow, row)) {
    void notifyManagerApplicationSubmitted(db, row).catch(
      bestEffortFailed("application submitted notice after fee promote", { id: row.id }),
    );
    // Forms set to go out once the application is submitted (the default Intake form).
    dispatchMoveInFormsForResidencyAfterResponse(row.id, "application-submitted");
  }

  return {
    ok: true,
    promoted: true,
    axisId: row.id,
    setupToken: prepared.setupToken,
  };
}
