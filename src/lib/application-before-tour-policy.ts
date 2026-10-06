/**
 * "Application before a tour" -- the pure policy, shared by the server gate
 * (`application-before-tour.server.ts`), the public listing projection and the Forms editor.
 *
 * ONE input decides it: the workspace setting (`leasingPipeline.applicationBeforeTour`, Settings ->
 * Workspace -> Automations). Captain, Oct 3 2026: "Tour order is just a workspace setting" --
 * an application form no longer has a tour order of its own. A `tourOrder` still stored on a template
 * (written before this rule) is IGNORED here; nothing reads it for a decision. No client value is read.
 */
import type { ApplicationBeforeTour } from "@/lib/leasing-pipeline-preferences";
import type { ApplicationTourOrder, PropertyApplicationTemplate } from "@/lib/property-application-templates";

/** @deprecated A form has no tour order of its own any more; kept only for the Forms library's stored facts. */
export const APPLICATION_TOUR_ORDER_OPTIONS: readonly { value: ApplicationTourOrder; label: string }[] = [
  { value: "workspace", label: "Use the workspace setting" },
  { value: "before_tour", label: "Before the tour" },
  { value: "after_tour", label: "After the tour" },
];

/** Anything that is not an explicit before/after is the workspace setting. */
export function normalizeApplicationTourOrder(raw: unknown): ApplicationTourOrder {
  return raw === "before_tour" || raw === "after_tour" ? raw : "workspace";
}

type FormLike = Pick<PropertyApplicationTemplate, "tourOrder" | "formVariant" | "listingSeedKey" | "publishedQuestionConfig">;

/** What a form says once the workspace setting is applied: true = apply before booking a tour. Its stored `tourOrder` is ignored. */
export function formRequiresApplicationBeforeTour(
  _form: Pick<FormLike, "tourOrder">,
  workspace: ApplicationBeforeTour,
): boolean {
  return workspace === "required";
}

/**
 * Is an application required before this property's tour? Only the workspace setting decides; the forms are
 * accepted so every caller keeps its signature, and none of their fields (a stored `tourOrder` included) counts.
 */
export function applicationBeforeTourRequired(
  workspace: ApplicationBeforeTour,
  _forms?: ReadonlyArray<FormLike> | null,
): boolean {
  return workspace === "required";
}

/**
 * What the resident's own application for THIS home says, as far as a tour is concerned.
 * `submitted` = sent and awaiting the manager; a draft, a withdrawn application and the
 * booking-residency plumbing row are `none`.
 */
export type TourApplicationStatus = "none" | "submitted" | "approved" | "denied";

/** Why a tour request is refused; null = it may proceed. */
export type TourBlockReason = "apply_first" | "pending_approval" | "denied";

export const TOUR_BLOCK_MESSAGES: Record<TourBlockReason, string> = {
  apply_first: "This home asks for an approved application before a tour. Apply first, then book your tour once it is approved.",
  pending_approval: "Your application for this home is still being reviewed. You can book a tour once it is approved.",
  denied: "Your application for this home was denied, so a tour cannot be booked here.",
};

/** One-line headings for an inline blocked state (no sentence under them). */
export const TOUR_BLOCK_LABELS: Record<TourBlockReason, string> = {
  apply_first: "Application approval required to book a tour",
  pending_approval: "Your application is under review",
  denied: "Tours unavailable",
};

/**
 * The one gate matrix (captain, Oct 3 2026), shared by the server refusal, the check route and the
 * pages:
 *   - setting off -> scheduling is open, whatever the application says (a denial included:
 *     a home that does not gate tours on an application does not gate them on a denial either);
 *   - setting on  -> only an APPROVED application schedules (none / submitted / denied do not),
 *     and a denial says so in its own words rather than "apply first".
 */
export function tourBlockReason(required: boolean, status: TourApplicationStatus): TourBlockReason | null {
  if (required && status === "denied") return "denied";
  if (!required) return null;
  if (status === "approved") return null;
  return status === "submitted" ? "pending_approval" : "apply_first";
}
