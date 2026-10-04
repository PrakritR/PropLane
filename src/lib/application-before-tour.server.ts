/**
 * "Application before a tour" (Settings -> Workspace -> Applications & leases).
 *
 * When the property's workspace says Required, a prospect may not file a tour request for that
 * property until their application for it is APPROVED (submitted is not enough), and a DENIED
 * application never schedules a tour for that home, whatever the setting (`tourBlockReason`). Everything here is re-derived on the
 * server: the owner and the setting come from the property record and the manager's saved
 * settings, the applicant from the verified account email, the application from
 * `manager_application_records` (scoped on the `resident_email` column, the resident's own rows).
 * A body field, a client flag or a claimed email proves nothing.
 *
 * Manager-scheduled tours (`createManualPlannedTour`, `book_tour`) and a manager accepting an
 * inquiry never come through here: the rule is about what a prospect may ask for.
 */
import "server-only";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadLeasingPipeline } from "@/lib/leasing-pipeline-preferences";
import {
  applicationBeforeTourRequired,
  tourBlockReason,
  TOUR_BLOCK_MESSAGES,
  type TourApplicationStatus,
  type TourBlockReason,
} from "@/lib/application-before-tour-policy";
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export const APPLICATION_BEFORE_TOUR_MESSAGE = TOUR_BLOCK_MESSAGES.apply_first;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isInProgressStage(stage: string): boolean {
  return stage.toLowerCase() === "in progress";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Pure: the strongest status among the caller's stored application rows for this property.
 * approved beats submitted beats denied. In-progress drafts, withdrawn applications and the
 * booking-residency plumbing row count as no application.
 */
export function applicationStatusForProperty(
  rows: ReadonlyArray<{ row_data?: unknown }>,
  propertyId: string,
): TourApplicationStatus {
  const pid = propertyId.trim();
  if (!pid) return "none";
  let status: TourApplicationStatus = "none";
  const rank: Record<TourApplicationStatus, number> = { none: 0, denied: 1, submitted: 2, approved: 3 };
  for (const record of rows) {
    const row = isObject(record.row_data) ? record.row_data : null;
    if (!row) continue;
    if (row.bookingResidency === true) continue;
    if (text(row.withdrawnAt)) continue;
    if (isInProgressStage(text(row.stage))) continue;
    const application = isObject(row.application) ? row.application : null;
    const rowProperty = text(row.propertyId) || text(application?.propertyId);
    if (rowProperty !== pid) continue;
    const bucket = text(row.bucket).toLowerCase();
    const stage = text(row.stage).toLowerCase();
    const next: TourApplicationStatus =
      bucket === "approved" || /^approved\b/.test(stage)
        ? "approved"
        : bucket === "rejected" || /^(declined|denied|rejected)\b/.test(stage)
          ? "denied"
          : "submitted";
    if (rank[next] > rank[status]) status = next;
  }
  return status;
}

/** Pure: does any stored application row count as "a submitted (or decided) application for this property"? */
export function hasSubmittedApplicationForProperty(
  rows: ReadonlyArray<{ row_data?: unknown }>,
  propertyId: string,
): boolean {
  return applicationStatusForProperty(rows, propertyId) !== "none";
}

export type ApplicationBeforeTourDecision = {
  /** The workspace setting: is an application required before a tour? */
  required: boolean;
  /** The caller's own application for this home (always "none" without a verified email). */
  applicationStatus: TourApplicationStatus;
  /** null = the caller may request a tour; otherwise why not. */
  blocked: TourBlockReason | null;
  /** Kept for callers that predate approval: a submitted or approved application exists. */
  hasApplication: boolean;
  ownerUserId: string | null;
};

/**
 * The property's owner (the workspace whose setting applies) and its application forms (each may
 * carry its own before/after-tour answer), or null when the property is unknown.
 */
async function propertyOwnerAndForms(
  db: Db,
  propertyId: string,
): Promise<{ ownerUserId: string; forms: PropertyApplicationTemplate[] } | null> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("manager_user_id, property_data")
    .eq("id", propertyId)
    .maybeSingle();
  // A failed read is NOT "the property has no owner". Swallowing it answered
  // `{ required: false }` and let an ungated tour through on a workspace that
  // requires an application first; the tour routes surface a throw as a 500.
  if (error) throw error;
  const row = data as { manager_user_id?: unknown; property_data?: unknown } | null;
  const ownerUserId = text(row?.manager_user_id);
  if (!ownerUserId) return null;
  const propertyData = isObject(row?.property_data) ? row.property_data : null;
  const submission = isObject(propertyData?.listingSubmission) ? propertyData.listingSubmission : null;
  const forms = Array.isArray(submission?.propertyApplicationTemplates)
    ? (submission.propertyApplicationTemplates as unknown[]).filter(isObject) as unknown as PropertyApplicationTemplate[]
    : [];
  return { ownerUserId, forms };
}

/**
 * Is an application required before this property's tour, what does `verifiedEmail`'s application
 * for it say, and so may they book? `verifiedEmail` MUST come from the session (or a trusted
 * channel), never from a request body; pass null when there is none and the caller reads as
 * "no application".
 */
export async function resolveApplicationBeforeTour(
  db: Db,
  args: { propertyId: string; verifiedEmail: string | null },
): Promise<ApplicationBeforeTourDecision> {
  const none = (required: boolean, ownerUserId: string | null): ApplicationBeforeTourDecision => ({
    required,
    applicationStatus: "none",
    blocked: tourBlockReason(required, "none"),
    hasApplication: false,
    ownerUserId,
  });
  const propertyId = args.propertyId.trim();
  if (!propertyId) return none(false, null);
  const owner = await propertyOwnerAndForms(db, propertyId);
  if (!owner) return none(false, null);
  const { ownerUserId, forms } = owner;
  const pipeline = await loadLeasingPipeline(db, ownerUserId);
  // Only the workspace setting decides whether an application is required.
  const required = applicationBeforeTourRequired(pipeline.applicationBeforeTour, forms);

  const email = (args.verifiedEmail ?? "").trim().toLowerCase();
  if (!email.includes("@")) return none(required, ownerUserId);
  const { data, error } = await db
    .from("manager_application_records")
    .select("row_data")
    .eq("resident_email", email)
    .eq("manager_user_id", ownerUserId);
  if (error) throw error;
  const applicationStatus = applicationStatusForProperty((data ?? []) as { row_data?: unknown }[], propertyId);
  return {
    required,
    applicationStatus,
    blocked: tourBlockReason(required, applicationStatus),
    hasApplication: applicationStatus === "submitted" || applicationStatus === "approved",
    ownerUserId,
  };
}

/** `null` = the prospect may request this tour; otherwise the refusal message. */
export async function applicationBeforeTourRefusal(
  db: Db,
  args: { propertyId: string; verifiedEmail: string | null },
): Promise<string | null> {
  const decision = await resolveApplicationBeforeTour(db, args);
  return decision.blocked ? TOUR_BLOCK_MESSAGES[decision.blocked] : null;
}
