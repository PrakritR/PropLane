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
import {
  findResidentApplicationsForListing,
  type DuplicateApplicationMatch,
} from "@/lib/rental-application/duplicate-application.server";
import {
  persistApplicationWrite,
  prepareResidentSelfWrite,
} from "@/lib/rental-application/signed-in-application-write.server";
import { loadResidentApplicationAutofillBasis } from "@/lib/rental-application/resident-application-autofill.server";
import {
  memoizeEffectiveApplicationProperty,
  validateResidentApplicationRowForPersistence,
} from "@/lib/rental-application/validate-application-submit.server";
import { authorizeApplicationFeeSubmission } from "@/lib/rental-application/application-fee-submit-guard.server";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";
import { isWizardFormFieldEnabled, isWizardFormFieldRequired } from "@/lib/rental-application/application-field-catalog";
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
  isEntireHomeListing,
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
  /** The listing's truthfulness certification, when it asks for one; stamped only from this. */
  consentTruth?: unknown;
  /** The typed signature line. */
  signature?: unknown;
  /**
   * Decide what the button should say, write nothing: `{ ready: true }`, `needsWizard`, `needsPayment`
   * or a duplicate. The sheet's confirmation and signature are not asked for.
   */
  dryRun?: unknown;
};

export type QuickApplyNeedsWizardReason =
  | "no_profile"
  | "no_listing"
  | "no_room"
  | "short_stay_only"
  | "missing_answers";

/**
 * Every room choice of this listing the caller already has a live application for, keyed by the same
 * `roomChoice1` value the rows carry. Returned on a dry run only, so the public card asks ONCE per
 * listing and answers "you already applied" for any room from the same reply instead of spending
 * another multi-read round trip on every room pick.
 */
export type QuickApplyAppliedRooms = Record<string, string>;

export type QuickApplyOutcome =
  | { status: 200; body: { ok: true; applicationId: string; href: string } }
  | { status: 200; body: { ready: true; appliedRooms?: QuickApplyAppliedRooms } }
  | {
      status: 200;
      body: {
        needsWizard: true;
        reason: QuickApplyNeedsWizardReason;
        missing?: string[];
        href: string;
        appliedRooms?: QuickApplyAppliedRooms;
      };
    }
  | { status: 200; body: { needsPayment: true; applicationId: string; href: string; appliedRooms?: QuickApplyAppliedRooms } }
  | { status: number; body: { error: string; existingApplicationId?: string; appliedRooms?: QuickApplyAppliedRooms } };

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
  const dryRun = input.dryRun === true;
  const signature = text(input.signature);
  if (!dryRun && input.confirmCurrent !== true) {
    return { status: 400, body: { error: "Confirm your saved answers are current." } };
  }
  if (!dryRun && !signature) return { status: 400, body: { error: "Type your full legal name as your signature." } };

  // 1. The saved answers. None means there is nothing to reuse: the wizard is the first application.
  const basis = await loadResidentApplicationAutofillBasis(db, ctx.email);
  if (!basis) {
    return {
      status: 200,
      body: { needsWizard: true, reason: "no_profile", href: quickApplyWizardHref(propertyId, requestedRoomId) },
    };
  }
  /**
   * The rooms of this listing the caller already holds an application for. Filled once the one listing
   * scan has run (step 3) and reported on every dry-run verdict, so the card never asks again per room.
   */
  let appliedRooms: QuickApplyAppliedRooms = {};
  const withApplied = <T extends object>(body: T): T & { appliedRooms?: QuickApplyAppliedRooms } =>
    dryRun && Object.keys(appliedRooms).length > 0 ? { ...body, appliedRooms } : body;
  const wizard = (reason: QuickApplyNeedsWizardReason, roomId = requestedRoomId, missing?: string[]): QuickApplyOutcome => ({
    status: 200,
    body: withApplied({
      needsWizard: true as const,
      reason,
      ...(missing && missing.length > 0 ? { missing } : {}),
      href: quickApplyWizardHref(propertyId, roomId),
    }),
  });

  // 2. The listing: live, and the questions it asks as the applicant would be shown them.
  const { data: record, error: recordError } = await db
    .from("manager_property_records")
    .select("manager_user_id, status")
    .eq("id", propertyId)
    .maybeSingle();
  if (recordError) return { status: 500, body: { error: "Could not load the listing. Try again." } };
  if (!record || record.status !== "live") return { status: 404, body: { error: "This listing is not taking applications." } };
  // One listing read for the whole request: this look at the rooms and questions, and the validator's
  // own look inside the shared write, are the same read.
  const loadProperty = memoizeEffectiveApplicationProperty(db);
  const loaded = await loadProperty(propertyId);
  if (!loaded.ok) return { status: 500, body: { error: "Could not load the listing. Try again." } };
  const property = loaded.property;
  const sub = property?.listingSubmission?.v === 1 ? property.listingSubmission : null;
  if (!property || !sub) return wizard("no_listing");

  // 3. One room. A listing with a single room needs no pick; otherwise the room is named.
  const email = ctx.email.trim().toLowerCase();
  /**
   * An entire-home listing is applied for as the WHOLE place, so the choice it stores is the property id
   * — exactly what the wizard's own prefill writes. The bedrooms such a listing carries are there to be
   * read, never picked: a bedroom stored as the unit choice is not the application the applicant made,
   * and the submit validator cannot catch it (its room-membership check is skipped for a whole home).
   */
  const entireHome = isEntireHomeListing(sub);
  const rooms = entireHome ? [] : sub.rooms.filter((room) => room.id);
  /**
   * One scan of everything this person already has on this listing: which rooms they have applied to,
   * and the live draft (if any) a fresh attempt must resume instead of minting a second row.
   *
   * A dry run asked before a room is picked is judged on one room. The ANSWERS do not depend on which,
   * but the duplicate verdict does — so it is judged on a room this person has not already applied to,
   * or Quick apply would disappear behind "View application" while every other room is still open.
   */
  const onListing = await findResidentApplicationsForListing(db, { residentEmail: email, propertyId });
  appliedRooms = Object.fromEntries([...onListing.byRoom].map(([choice, match]) => [choice, match.id]));
  const probeRoomId =
    dryRun && !requestedRoomId && rooms.length > 1
      ? rooms.find((room) => !onListing.byRoom.has(roomChoiceValue(propertyId, room.id)))?.id
      : undefined;
  const roomId = entireHome
    ? ""
    : requestedRoomId || (rooms.length === 1 || dryRun ? (probeRoomId ?? rooms[0]?.id ?? "") : "");
  if (!entireHome) {
    if (!roomId) return wizard("no_room");
    if (!rooms.some((room) => room.id === roomId)) return { status: 400, body: { error: "Choose a room of this listing." } };
  }
  const roomChoice = entireHome ? propertyId : roomChoiceValue(propertyId, roomId);

  // 4. Lease defaults come from the listing, never from the last application.
  const offered = resolveOfferedLeaseTermsOrDefault(sub);
  const kinds = leaseKindsOffered(offered);
  if (!kinds.long) return wizard("short_stay_only", roomId);
  const leaseTerm = defaultStoredTermForKind("long", offered);
  const today = todayISO();
  // A dry run is asked BEFORE the sheet collects its own fields (move-in, screening consent, the
  // signature), so they stand in as filled: the verdict is about what the SAVED answers cannot cover.
  const leaseStart = text(input.leaseStart, 10) || (dryRun ? today : "");
  const fixedLengths = kinds.longTerm ? normalizeLongTermLengths(sub.longTermLengthsOffered) : [];
  const leaseEnd = leaseStart && fixedLengths.length > 0 ? addMonthsToDateString(leaseStart, fixedLengths[0]!) : "";

  // 5. The questions the listing asks, answered from the saved custom answers by key AND type.
  const { config, templateId, templateVersion } = applicationConfigForApplicant(sub, "standard");
  const customFields = listingCustomApplicationFields(config);
  const customFieldAnswers = carryCustomFieldAnswers(customFields, basis.customFieldAnswers);
  const missingCustom = Object.keys(validateCustomFieldAnswers(customFields, customFieldAnswers));
  if (missingCustom.length > 0) return wizard("missing_answers", roomId, missingCustom);

  const wantsScreening = isWizardFormFieldEnabled(config, "consentCredit");
  /**
   * The truthfulness certification is a legal attestation the manager reads as "Accuracy confirmed" and
   * the application PDF prints as acknowledged, so it is recorded only from the applicant's OWN tick of
   * the sheet's box, which carries this listing's wording — never stamped for them, and never at all for
   * a listing that does not ask the question. When the listing requires it and the sheet could not put
   * that sentence in front of them, the full application opens (where the question lives) rather than
   * the sheet refusing with a box it is not showing.
   */
  const wantsTruth = isWizardFormFieldEnabled(config, "consentTruth");
  if (!dryRun && isWizardFormFieldRequired(config, "consentTruth") && input.consentTruth !== true) {
    return wizard("missing_answers", roomId, ["consentTruth"]);
  }
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
    roomChoice1: roomChoice,
    rentalType: "standard",
    leaseTerm,
    leaseStart,
    leaseEnd,
    applicationTemplateId: templateId,
    applicationTemplateVersion: templateVersion,
    customFieldAnswers,
    email,
    consentCredit: wantsScreening && (dryRun || input.consentCredit === true),
    consentTruth: wantsTruth && (dryRun || input.consentTruth === true),
    digitalSignature: signature || (dryRun ? "dry run" : ""),
    dateSigned: today,
    wizardStepSchema: createInitialRentalWizardState().wizardStepSchema,
  };

  /**
   * The resident's own live draft for this room IS this application: Quick apply resumes it instead of
   * minting a second id. Nothing downstream can tell two drafts for one room apart — the duplicate
   * guards skip draft rows by design, and the wizard resumes only the first — so a new id per attempt
   * would stack "Incomplete" rows in the manager's list; and because a fee claim is keyed on the
   * application id, it would also orphan a fee the resident had already paid against the draft.
   */
  const applicationId = onListing.draftsByRoom.get(roomChoice)?.id || newApplicationId();
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
  const duplicate: DuplicateApplicationMatch | null = onListing.byRoom.get(application.roomChoice1) ?? null;
  if (duplicate) {
    return {
      status: 409,
      body: withApplied({ error: "You already applied to this room.", existingApplicationId: duplicate.id }),
    };
  }

  // 7. A fee that is OWED is never skipped: the application is kept as a draft at the last step. A guard
  // that could not read the row at all is a refusal, not an invoice — never turn that into "go and pay".
  const fee = await authorizeApplicationFeeSubmission(db, submittedRow);
  if (!fee.ok && fee.reason !== "unpaid") return { status: fee.status, body: { error: fee.error } };
  const feeOwed = !fee.ok;
  if (dryRun) {
    if (feeOwed) {
      return {
        status: 200,
        body: withApplied({ needsPayment: true as const, applicationId: "", href: quickApplyWizardHref(propertyId, roomId) }),
      };
    }
    // The SAME validator the submit runs (`prepareResidentSelfWrite`), so the button cannot promise a
    // one-sheet apply the shared write will then refuse for an answer the saved profile never carried.
    const validation = await validateResidentApplicationRowForPersistence(db, submittedRow, { loadProperty });
    if (!validation.ok) {
      const missing = Object.keys(validation.fieldErrors ?? {});
      if (validation.status === 422 && missing.length > 0) return wizard("missing_answers", roomId, missing);
      return { status: validation.status, body: { error: validation.error } };
    }
    return { status: 200, body: withApplied({ ready: true as const }) };
  }
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
    loadProperty,
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
