/**
 * "Application before a tour" (Settings -> Workspace -> Applications & leases).
 *
 * When the property's workspace says Required, a prospect may not file a tour request for that
 * property until they have a SUBMITTED application for it. Everything here is re-derived on the
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
import { applicationBeforeTourRequired } from "@/lib/application-before-tour-policy";
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export const APPLICATION_BEFORE_TOUR_MESSAGE =
  "This home asks for an application before a tour. Apply first, then book your tour.";

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
 * Pure: does any stored application row count as "a submitted application for this property"?
 * In-progress drafts, withdrawn applications and the booking-residency plumbing row do not.
 */
export function hasSubmittedApplicationForProperty(
  rows: ReadonlyArray<{ row_data?: unknown }>,
  propertyId: string,
): boolean {
  const pid = propertyId.trim();
  if (!pid) return false;
  return rows.some((record) => {
    const row = isObject(record.row_data) ? record.row_data : null;
    if (!row) return false;
    if (row.bookingResidency === true) return false;
    if (text(row.withdrawnAt)) return false;
    if (isInProgressStage(text(row.stage))) return false;
    const application = isObject(row.application) ? row.application : null;
    const rowProperty = text(row.propertyId) || text(application?.propertyId);
    return rowProperty === pid;
  });
}

export type ApplicationBeforeTourDecision =
  | { required: false }
  | { required: true; hasApplication: boolean; ownerUserId: string };

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
 * Is an application required before this property's tour, and does `verifiedEmail` have one?
 * `verifiedEmail` MUST come from the session (or a trusted channel), never from a request body;
 * pass null when there is none and a required workspace will read as "no application".
 */
export async function resolveApplicationBeforeTour(
  db: Db,
  args: { propertyId: string; verifiedEmail: string | null },
): Promise<ApplicationBeforeTourDecision> {
  const propertyId = args.propertyId.trim();
  if (!propertyId) return { required: false };
  const owner = await propertyOwnerAndForms(db, propertyId);
  if (!owner) return { required: false };
  const { ownerUserId, forms } = owner;
  const pipeline = await loadLeasingPipeline(db, ownerUserId);
  // The workspace setting AND each form's own before/after-tour answer, decided in one place.
  if (!applicationBeforeTourRequired(pipeline.applicationBeforeTour, forms)) return { required: false };

  const email = (args.verifiedEmail ?? "").trim().toLowerCase();
  if (!email.includes("@")) return { required: true, hasApplication: false, ownerUserId };
  const { data, error } = await db
    .from("manager_application_records")
    .select("row_data")
    .eq("resident_email", email)
    .eq("manager_user_id", ownerUserId);
  if (error) throw error;
  return {
    required: true,
    hasApplication: hasSubmittedApplicationForProperty((data ?? []) as { row_data?: unknown }[], propertyId),
    ownerUserId,
  };
}

/** `null` = the prospect may request this tour; otherwise the refusal message. */
export async function applicationBeforeTourRefusal(
  db: Db,
  args: { propertyId: string; verifiedEmail: string | null },
): Promise<string | null> {
  const decision = await resolveApplicationBeforeTour(db, args);
  if (!decision.required || decision.hasApplication) return null;
  return APPLICATION_BEFORE_TOUR_MESSAGE;
}
