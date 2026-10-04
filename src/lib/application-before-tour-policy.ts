/**
 * "Application before a tour" -- the pure policy, shared by the server gate
 * (`application-before-tour.server.ts`), the public listing projection and the Forms editor.
 *
 * ONE input decides it: the workspace setting (`leasingPipeline.applicationBeforeTour`, Settings ->
 * Workspace -> Applications & leases). Captain, Oct 3 2026: "Tour order is just a workspace setting" --
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
