/**
 * Quick apply: a signed-in resident who has applied before submits a new SOLO application to one room in
 * one request, from the answers their last application already holds.
 *
 * It is not a second submit path. The row it builds goes through the same `prepareResidentSelfWrite` /
 * `persistApplicationWrite` pair as `POST /api/manager-applications` (validation, fee guard, resident link,
 * linked forms, manager notice, move-in forms, screening), so the only thing that is new here is deciding
 * whether the saved answers are enough. When they are not, the answer is `needsWizard` with the question
 * keys that are missing, and the wizard opens prefilled; when a fee is owed the application is saved as a
 * draft at the last step and the answer is `needsPayment`. Nothing here bypasses a fee.
 *
 * Owner document: `docs/agents/application-questions.md` § Quick apply.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { findDuplicateApplication } from "@/lib/rental-application/duplicate-application.server";
import {
  persistApplicationWrite,
  prepareResidentSelfWrite,
} from "@/lib/rental-application/signed-in-application-write.server";
import { loadResidentApplicationAutofillBasis } from "@/lib/rental-application/resident-application-autofill.server";
import { loadEffectiveApplicationProperty } from "@/lib/rental-application/validate-application-submit.server";
import { authorizeApplicationFeeSubmission } from "@/lib/rental-application/application-fee-submit-guard.server";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";
import { isWizardFormFieldEnabled } from "@/lib/rental-application/application-field-catalog";
import {
  customFieldAnswerValue,
  isCustomFieldHiddenByCondition,
  listingCustomApplicationFields,
  upsertCustomFieldAnswer,
  validateCustomFieldAnswers,
} from "@/lib/rental-application/custom-fields";
import { IN_PROGRESS_APPLICATION_STAGE } from "@/lib/rental-application/draft-shape";
import { defaultStoredTermForKind, leaseKindsOffered } from "@/lib/rental-application/lease-choice";
import { addMonthsToDateString } from "@/lib/rental-application/long-term-length";
import { roomChoiceValue } from "@/lib/rental-application/room-choice-value";
import { createInitialRentalWizardState, todayISO } from "@/lib/rental-application/state";
import {
  normalizeLongTermLengths,
  resolveOfferedLeaseTermsOrDefault,
} from "@/lib/manager-listing-submission";
import {
  RENTAL_WIZARD_STEP_COUNT,
  type RentalCustomFieldAnswer,
  type RentalWizardFormState,
} from "@/lib/rental-application/types";

type PrepareUser = Parameters<typeof prepareResidentSelfWrite>[1];

export type QuickApplyInput = {
  propertyId?: unknown;
  roomId?: unknown;
  leaseStart?: unknown;
  /** The sheet's "consent to screening" box; only meaningful when the listing asks for it. */
  consentCredit?: unknown;
  /** The sheet's "I confirm my saved answers are current" box. */
  confirmCurrent?: unknown;
  /** The typed signature line. */
  signature?: unknown;
};

export type QuickApplyNeedsWizardReason =
  | "no_profile"
  | "no_listing"
  | "no_room"
  | "short_stay_only"
  | "missing_answers";

export type QuickApplyOutcome =
  | { status: 200; body: { ok: true; applicationId: string; href: string } }
  | { status: 200; body: { needsWizard: true; reason: QuickApplyNeedsWizardReason; missing?: string[]; href: string } }
  | { status: 200; body: { needsPayment: true; applicationId: string; href: string } }
  | { status: number; body: { error: string; existingApplicationId?: string } };

const text = (value: unknown, max = 200): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

function newApplicationId(): string {
  return `PROPLANE-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/** The wizard for this listing and room, opened with the saved answers already in. */
export function quickApplyWizardHref(propertyId: string, roomId?: string): string {
  const q = new URLSearchParams({ propertyId });
  if (roomId) q.set("listingRoomId", roomId);
  q.set("prefill", "1");
  return `/resident/applications/apply?${q.toString()}`;
}

export function quickApplyDetailHref(applicationId: string): string {
  return `/resident/applications/pending/${encodeURIComponent(applicationId)}`;
}

/**
 * The custom answers the next listing can reuse: for every question the listing asks (and its `showIf` leaves
 * visible), the earlier answer with the SAME key and the SAME type. Label changes do not matter, a changed type
 * does, because the stored value of one type is not a valid answer to another.
 */
export function carryCustomFieldAnswers(
  fields: ReturnType<typeof listingCustomApplicationFields>,
  earlier: readonly RentalCustomFieldAnswer[],
): RentalCustomFieldAnswer[] {
  let answers: RentalCustomFieldAnswer[] = [];
  for (const field of fields) {
    if (isCustomFieldHiddenByCondition(field, answers)) continue;
    const prior = earlier.find((answer) => answer.key === field.key && answer.type === field.type);
    if (!prior || !customFieldAnswerValue([prior], field.key).trim()) continue;
    answers = upsertCustomFieldAnswer(answers, field, prior.value);
  }
  return answers;
}

export async function runQuickApply(
  db: SupabaseClient,
  ctx: { user: PrepareUser; role: string; email: string; leadSource: string | null },
  input: QuickApplyInput,
): Promise<QuickApplyOutcome> {
  const propertyId = text(input.propertyId);
  if (!propertyId) return { status: 400, body: { error: "Choose a listing." } };
  const requestedRoomId = text(input.roomId);
  const signature = text(input.signature);
  if (input.confirmCurrent !== true) {
    return { status: 400, body: { error: "Confirm your saved answers are current." } };
  }
  if (!signature) return { status: 400, body: { error: "Type your full legal name as your signature." } };

  // 1. The saved answers. None means there is nothing to reuse: the wizard is the first application.
  const basis = await loadResidentApplicationAutofillBasis(db, ctx.email);
  if (!basis) {
    return {
      status: 200,
      body: { needsWizard: true, reason: "no_profile", href: quickApplyWizardHref(propertyId, requestedRoomId) },
    };
  }
  const wizard = (reason: QuickApplyNeedsWizardReason, roomId = requestedRoomId, missing?: string[]): QuickApplyOutcome => ({
    status: 200,
    body: {
      needsWizard: true,
      reason,
      ...(missing && missing.length > 0 ? { missing } : {}),
      href: quickApplyWizardHref(propertyId, roomId),
    },
  });

  // 2. The listing: live, and the questions it asks as the applicant would be shown them.
  const { data: record, error: recordError } = await db
    .from("manager_property_records")
    .select("manager_user_id, status")
    .eq("id", propertyId)
    .maybeSingle();
  if (recordError) return { status: 500, body: { error: "Could not load the listing. Try again." } };
  if (!record || record.status !== "live") return { status: 404, body: { error: "This listing is not taking applications." } };
  const loaded = await loadEffectiveApplicationProperty(db, propertyId);
  if (!loaded.ok) return { status: 500, body: { error: "Could not load the listing. Try again." } };
  const property = loaded.property;
  const sub = property?.listingSubmission?.v === 1 ? property.listingSubmission : null;
  if (!property || !sub) return wizard("no_listing");

  // 3. One room. A listing with a single room needs no pick; otherwise the room is named.
  const rooms = sub.rooms.filter((room) => room.id);
  const roomId = requestedRoomId || (rooms.length === 1 ? rooms[0]!.id : "");
  if (!roomId) return wizard("no_room");
  if (!rooms.some((room) => room.id === roomId)) return { status: 400, body: { error: "Choose a room of this listing." } };

  // 4. Lease defaults come from the listing, never from the last application.
  const offered = resolveOfferedLeaseTermsOrDefault(sub);
  const kinds = leaseKindsOffered(offered);
  if (!kinds.long) return wizard("short_stay_only", roomId);
  const leaseTerm = defaultStoredTermForKind("long", offered);
  const leaseStart = text(input.leaseStart, 10);
  const fixedLengths = kinds.longTerm ? normalizeLongTermLengths(sub.longTermLengthsOffered) : [];
  const leaseEnd = leaseStart && fixedLengths.length > 0 ? addMonthsToDateString(leaseStart, fixedLengths[0]!) : "";

  // 5. The questions the listing asks, answered from the saved custom answers by key AND type.
  const { config, templateId, templateVersion } = applicationConfigForApplicant(sub, "standard");
  const customFields = listingCustomApplicationFields(config);
  const customFieldAnswers = carryCustomFieldAnswers(customFields, basis.customFieldAnswers);
  const missingCustom = Object.keys(validateCustomFieldAnswers(customFields, customFieldAnswers));
  if (missingCustom.length > 0) return wizard("missing_answers", roomId, missingCustom);

  const wantsScreening = isWizardFormFieldEnabled(config, "consentCredit");
  const today = todayISO();
  const email = ctx.email.trim().toLowerCase();
  const application: RentalWizardFormState = {
    ...createInitialRentalWizardState(),
    ...basis.profile,
    // SOLO: a group is a separate act with its own id and roster, never inherited from a past application.
    applyingAsGroup: null,
    groupRole: null,
    groupSize: "",
    groupId: "",
    groupLeaderAppId: "",
    bundleId: "",
    propertyId,
    roomChoice1: roomChoiceValue(propertyId, roomId),
    rentalType: "standard",
    leaseTerm,
    leaseStart,
    leaseEnd,
    applicationTemplateId: templateId,
    applicationTemplateVersion: templateVersion,
    customFieldAnswers,
    email,
    consentCredit: wantsScreening && input.consentCredit === true,
    consentTruth: true,
    digitalSignature: signature,
    dateSigned: today,
    wizardStepSchema: createInitialRentalWizardState().wizardStepSchema,
  };

  const applicationId = newApplicationId();
  const submittedRow: DemoApplicantRow = {
    id: applicationId,
    name: application.fullLegalName.trim() || signature,
    property: property.title?.trim() || propertyId,
    propertyId,
    managerUserId: record.manager_user_id ?? null,
    stage: "Submitted",
    bucket: "pending",
    backgroundCheckStatus: "pending_review",
    detail: `Submitted with Quick apply ${new Date().toLocaleString()}`,
    email,
    residentUserId: ctx.user.id,
    axisId: applicationId,
    quickApplied: true,
    application,
  };

  // 6. The same person never applies to the same room twice.
  const duplicate = await findDuplicateApplication(db, { residentEmail: email, row: submittedRow });
  if (duplicate) {
    return { status: 409, body: { error: "You already applied to this room.", existingApplicationId: duplicate.id } };
  }

  // 7. A fee that is owed is never skipped: the application is kept as a draft at the last step.
  const fee = await authorizeApplicationFeeSubmission(db, submittedRow);
  if (!fee.ok && fee.status !== 409) return { status: fee.status, body: { error: fee.error } };
  const feeOwed = !fee.ok;
  const row: DemoApplicantRow = feeOwed
    ? {
        ...submittedRow,
        stage: IN_PROGRESS_APPLICATION_STAGE,
        detail: "Started with Quick apply",
        application: {
          ...application,
          wizardStep: RENTAL_WIZARD_STEP_COUNT,
          wizardMaxStepReached: RENTAL_WIZARD_STEP_COUNT,
        },
      }
    : submittedRow;

  // 8. The shared signed-in write: everything the wizard's own submit does.
  const prepared = await prepareResidentSelfWrite(db, ctx.user, {
    row,
    requestedRowId: applicationId,
    role: ctx.role,
    email: ctx.email.trim().toLowerCase(),
  });
  if (!prepared.ok) {
    const fieldErrors = prepared.body.fieldErrors as Record<string, string> | undefined;
    if (prepared.status === 422 && fieldErrors && Object.keys(fieldErrors).length > 0) {
      return wizard("missing_answers", roomId, Object.keys(fieldErrors));
    }
    return {
      status: prepared.status,
      body: {
        error: String(prepared.body.error ?? "Could not submit the application."),
        ...(typeof prepared.body.existingApplicationId === "string"
          ? { existingApplicationId: prepared.body.existingApplicationId }
          : {}),
      },
    };
  }
  const persisted = await persistApplicationWrite(db, {
    user: ctx.user,
    row: prepared.row,
    requestedRowId: applicationId,
    authorizedWriteRecord: prepared.authorizedWriteRecord,
    residentSelfWrite: true,
    leadSource: ctx.leadSource,
  });
  if (!persisted.ok) {
    return { status: persisted.status, body: { error: String(persisted.body.error ?? "Could not submit the application.") } };
  }
  const savedId = String(persisted.row.id);
  if (feeOwed) {
    return {
      status: 200,
      body: { needsPayment: true, applicationId: savedId, href: quickApplyWizardHref(propertyId, roomId) },
    };
  }
  return { status: 200, body: { ok: true, applicationId: savedId, href: quickApplyDetailHref(savedId) } };
}
