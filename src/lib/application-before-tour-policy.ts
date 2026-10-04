/**
 * "Application before a tour" -- the pure policy, shared by the server gate
 * (`application-before-tour.server.ts`), the public listing projection and the Forms editor.
 *
 * Two inputs decide it: the workspace setting (`leasingPipeline.applicationBeforeTour`) and each
 * application form's own `tourOrder`. A form says "before the tour", "after the tour" or "use the
 * workspace setting". A prospect asking for a tour has not picked a lease type yet, so the tour is
 * gated when ANY of the property's live application forms resolves to "before the tour"; with no
 * live form the workspace setting alone decides. No client value is read here.
 */
import type { ApplicationBeforeTour } from "@/lib/leasing-pipeline-preferences";
import type { ApplicationTourOrder, PropertyApplicationTemplate } from "@/lib/property-application-templates";

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

function isCosignerForm(form: Pick<FormLike, "formVariant" | "listingSeedKey">): boolean {
  return form.formVariant === "cosigner" || form.listingSeedKey === "cosigner" || form.listingSeedKey === "cosigner-short-term";
}

/** What one form says once the workspace setting is applied: true = apply before booking a tour. */
export function formRequiresApplicationBeforeTour(
  form: Pick<FormLike, "tourOrder">,
  workspace: ApplicationBeforeTour,
): boolean {
  const order = normalizeApplicationTourOrder(form.tourOrder);
  if (order === "before_tour") return true;
  if (order === "after_tour") return false;
  return workspace === "required";
}

/** Is an application required before a tour of a property that offers `forms`? */
export function applicationBeforeTourRequired(
  workspace: ApplicationBeforeTour,
  forms: ReadonlyArray<FormLike> | null | undefined,
): boolean {
  const live = (forms ?? []).filter((form) => !isCosignerForm(form) && Boolean(form.publishedQuestionConfig));
  if (live.length === 0) return workspace === "required";
  return live.some((form) => formRequiresApplicationBeforeTour(form, workspace));
}
