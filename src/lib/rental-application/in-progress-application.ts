import type { DemoApplicantRow } from "@/data/demo-portal";
import { isLegitimateEmail } from "@/lib/email-address";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";
import {
  readManagerApplicationRows,
  replaceManagerApplicationRowInCache,
  upsertApplicationRowToServer,
  wouldDowngradeSubmittedApplication,
} from "@/lib/manager-applications-storage";
import {
  INCOMPLETE_APPLICATION_LABEL,
  IN_PROGRESS_APPLICATION_STAGE,
  isDraftShapedApplicationRow,
  isSubmittedStage,
} from "@/lib/rental-application/draft-shape";
import { getPropertyById, parseRoomChoiceValue } from "@/lib/rental-application/data";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import {
  clearRentalWizardDraft,
  loadRentalWizardDraftAxisId,
  saveRentalWizardDraftAxisId,
} from "@/lib/rental-application/drafts";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

// The draft-shape vocabulary lives in `draft-shape.ts` so
// `manager-applications-storage.ts` can read it without importing this module
// back (this one already imports four runtime values from it). Re-exported here
// so every existing import path keeps working.
export {
  IN_PROGRESS_APPLICATION_STAGE,
  INCOMPLETE_APPLICATION_LABEL,
  isDraftShapedApplicationRow,
} from "@/lib/rental-application/draft-shape";

/** Pending draft applications — stored as "In progress", shown in the UI as "Incomplete". */
export function isInProgressApplicationRow(row: DemoApplicantRow): boolean {
  return !isWithdrawnApplicationRow(row) && isDraftShapedApplicationRow(row);
}

/** Incomplete / in-progress drafts are eligible for the manager completion reminder. */
export function shouldOfferApplicationCompletionReminder(
  row: DemoApplicantRow,
  opts?: { viewingIncompleteApplicationDetail?: boolean },
): boolean {
  if (isInProgressApplicationRow(row)) return true;
  if (row.bucket !== "pending" || isWithdrawnApplicationRow(row)) return false;
  if (opts?.viewingIncompleteApplicationDetail) return !isSubmittedStage(row);
  return false;
}

/**
 * A resident may hold several in-progress applications at once — different
 * properties, or different rooms in the same property. This identifies WHICH
 * one (if any) a fresh apply request is really asking to resume: same
 * property, and (when either side names one) the same room or bundle.
 * Nothing broader — a different property, or an explicitly different room in
 * the same property, must always start a new application, never hijack this one.
 */
export type ApplicationRequestTarget = {
  propertyId: string;
  listingRoomId?: string;
  bundleId?: string;
};

type ApplicationSnapshot = {
  propertyId?: string | null;
  application?: Partial<Pick<RentalWizardFormState, "propertyId" | "roomChoice1" | "bundleId">> | null;
};

/**
 * True when `candidate` (an existing in-progress application, or a locally
 * loaded draft) IS the application `target` is asking for. Matching is
 * intentionally asymmetric: a request that names no room/bundle at all is
 * compatible with any draft for that property (so re-clicking "Apply" on a
 * listing without picking a room keeps resuming the same draft instead of
 * spawning a new one every time); a request that DOES name a specific room
 * or bundle only matches a candidate with that exact room/bundle (or one that
 * hasn't committed to one yet) — never a candidate committed to a different one.
 */
export function targetMatchesApplication(target: ApplicationRequestTarget, candidate: ApplicationSnapshot): boolean {
  const targetPid = target.propertyId.trim();
  if (!targetPid) return false;
  const candidatePid = candidate.propertyId?.trim() || candidate.application?.propertyId?.trim() || "";
  if (candidatePid !== targetPid) return false;

  const targetBundle = target.bundleId?.trim();
  const candidateBundle = candidate.application?.bundleId?.trim() || "";
  if (targetBundle) return targetBundle === candidateBundle;
  if (candidateBundle) return false; // request wants a per-room/plain application; this candidate is a bundle application.

  const targetRoom = target.listingRoomId?.trim();
  if (!targetRoom) return true; // no room named — any draft for this property matches.
  const candidateRoomChoice = candidate.application?.roomChoice1?.trim() || "";
  const candidateRoom = candidateRoomChoice ? parseRoomChoiceValue(candidateRoomChoice).listingRoomId : undefined;
  if (!candidateRoom) return true; // candidate hasn't committed to a room either — compatible.
  return candidateRoom === targetRoom;
}

/**
 * Finds the resident's in-progress row (if any) that matches an apply target.
 * `target === null` means the request named no property at all (a bare, legacy
 * `/apply` entry) — the only case where falling back to "any in-progress row"
 * is still correct, because there is nothing more specific to match against.
 *
 * Withdrawn rows are excluded: withdrawal is FINAL for the applicant, so
 * reapplying to the same property must start a brand-new application rather
 * than resume the withdrawn draft (no revived row, no leftover answers).
 */
export function findInProgressRowForTarget(
  rows: DemoApplicantRow[],
  target: ApplicationRequestTarget | null,
): DemoApplicantRow | undefined {
  const inProgress = rows.filter((row) => isInProgressApplicationRow(row) && !isWithdrawnApplicationRow(row));
  if (!target?.propertyId.trim()) return inProgress[0];
  return inProgress.find((row) => targetMatchesApplication(target, row));
}

/** Display label for application stage everywhere in the product UI, PDFs, and assistant tools. */
export function applicationStageDisplayLabel(row: Pick<DemoApplicantRow, "bucket" | "stage">): string {
  if (isInProgressApplicationRow(row as DemoApplicantRow)) return INCOMPLETE_APPLICATION_LABEL;
  const stage = row.stage?.trim();
  if (stage) return stage;
  if (row.bucket === "approved") return "Approved";
  if (row.bucket === "rejected") return "Rejected";
  return "Pending review";
}

/**
 * Submitted applications awaiting manager review (pending bucket, not a draft).
 * A resident-withdrawn application keeps `bucket === "pending"` but is NOT
 * awaiting review — the resident pulled out — so it is excluded here to keep it
 * off the manager's actionable "needs attention" surfaces (nav badge, dashboard).
 * It stays visible in the Applications tab, labelled Withdrawn.
 */
export function isSubmittedPendingApplicationRow(row: DemoApplicantRow): boolean {
  return row.bucket === "pending" && !isInProgressApplicationRow(row) && !isWithdrawnApplicationRow(row);
}

/**
 * The "Started …" / "Submitted …" / "Updated …" stamp an application row keeps
 * in `detail` (written here and by the wizard). `detail` also carries free
 * prose for approved rows ("Lease signed — move-in scheduled"), so only the
 * timestamped shapes are returned — a list that prints this must not print a
 * sentence where it promised a date.
 *
 * Resident audit F7: twelve byte-identical application rows were genuinely
 * indistinguishable because the list showed neither date, status nor id.
 */
export function applicationStartedLabel(row: Pick<DemoApplicantRow, "detail">): string {
  const detail = row.detail?.trim() ?? "";
  return /^(started|submitted|updated)\s/i.test(detail) ? detail : "";
}

export type ApplicationResumeLinkCredentials = {
  token: string;
  axisId: string;
};

export function inProgressApplicationResumeUrl(
  origin: string,
  row: DemoApplicantRow,
  resume?: ApplicationResumeLinkCredentials,
): string {
  const base = origin.replace(/\/$/, "");
  const pid = row.propertyId?.trim() || row.application?.propertyId?.trim();
  const params = new URLSearchParams();
  if (pid) params.set("propertyId", pid);
  const token = resume?.token?.trim();
  const axisId = resume?.axisId?.trim();
  if (token && axisId) {
    params.set("token", token);
    params.set("proplane_id", formatProplaneIdForDisplay(axisId));
  }
  const qs = params.toString();
  const path = qs ? `/rent/apply?${qs}` : "/rent/apply";
  return `${base}${path}`;
}

export function mintApplicationAxisId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `PROPLANE-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  }
  return `PROPLANE-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * When an applicant picks a different property, either resume their existing
 * in-progress row for that property or mint a fresh axis id so the prior
 * application is left untouched.
 */
export function switchApplicationTargetProperty(input: {
  previousPropertyId: string;
  nextPropertyId: string;
  inProgressRows: DemoApplicantRow[];
}): { axisId: string; resumedApplication?: RentalWizardFormState } | null {
  const previousPropertyId = input.previousPropertyId.trim();
  const nextPropertyId = input.nextPropertyId.trim();
  if (!nextPropertyId || previousPropertyId === nextPropertyId) return null;

  const hit = findInProgressRowForTarget(input.inProgressRows, { propertyId: nextPropertyId });
  if (hit?.application) {
    saveRentalWizardDraftAxisId(hit.id);
    return {
      axisId: hit.id,
      resumedApplication: {
        ...createInitialRentalWizardState(),
        ...hit.application,
      },
    };
  }

  const boundAxisId = loadRentalWizardDraftAxisId()?.trim();
  if (boundAxisId) {
    clearRentalWizardDraft();
  }
  const axisId = mintApplicationAxisId();
  saveRentalWizardDraftAxisId(axisId);
  return { axisId };
}

/** True when a draft snapshot should sync to the server (portal or public guest apply). */
export function shouldSyncInProgressDraft(input: {
  email: string;
  propertyId: string;
}): boolean {
  return isLegitimateEmail(input.email) && Boolean(input.propertyId.trim());
}

export function buildInProgressApplicationRow(input: {
  axisId: string;
  form: RentalWizardFormState;
  residentEmail: string;
  /** Live wizard position, persisted so a reload / redirect return resumes here. */
  wizardStep?: number;
  wizardMaxStepReached?: number;
}): DemoApplicantRow {
  const pid = input.form.propertyId.trim();
  const prop = pid ? getPropertyById(pid) : undefined;
  const email = input.residentEmail.trim();
  // NOT a literal "Applicant" placeholder: this value is stored, and the
  // report display context indexes resident names off it, so a nameless draft
  // used to rename the person on every one of their finance rows (F-FIN-2).
  // Empty means "no name yet"; every display site falls back to the email.
  const name = input.form.fullLegalName.trim();

  // The live step wins over whatever the form snapshot happened to carry — step
  // lives in wizard state, not the form, so it is injected fresh on every sync.
  const application: RentalWizardFormState = {
    ...structuredClone(input.form),
    ...(typeof input.wizardStep === "number" ? { wizardStep: input.wizardStep } : {}),
    ...(typeof input.wizardMaxStepReached === "number"
      ? { wizardMaxStepReached: input.wizardMaxStepReached }
      : {}),
  };

  return {
    id: input.axisId,
    name,
    property: (prop?.title?.trim() || pid) || "Listing",
    propertyId: pid || undefined,
    managerUserId: prop?.managerUserId ?? null,
    stage: IN_PROGRESS_APPLICATION_STAGE,
    bucket: "pending",
    backgroundCheckStatus: "pending_review",
    detail: `Started ${new Date().toLocaleString()}`,
    email,
    application,
  };
}

const submitInitiatedAxisIds = new Set<string>();

/**
 * Marks an axis id as having entered submit, so the wizard's per-keystroke draft
 * effect stops issuing draft writes for it. This is only a cheap second layer —
 * the authoritative defense is the conditional write in the API route, which no
 * caller can bypass.
 */
export function markApplicationSubmitInitiated(axisId: string): void {
  const id = axisId.trim();
  if (id) submitInitiatedAxisIds.add(id);
}

export function syncInProgressApplicationRow(input: {
  axisId: string;
  form: RentalWizardFormState;
  residentEmail: string;
  wizardStep?: number;
  wizardMaxStepReached?: number;
}): void {
  const row = buildInProgressApplicationRow(input);
  if (submitInitiatedAxisIds.has(row.id.trim())) return;
  // Never walk a submitted application back to a draft. The server enforces this
  // too (a draft POST can still be in flight when submit lands); this keeps the
  // local cache honest and avoids issuing the doomed write at all.
  const existing = readManagerApplicationRows().find((cached) => cached.id === row.id);
  if (wouldDowngradeSubmittedApplication(existing, row)) return;

  replaceManagerApplicationRowInCache(row);
  upsertApplicationRowToServer(row);
}
