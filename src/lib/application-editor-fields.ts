import { normalizeCustomApplicationFieldsForEditor } from "@/lib/manager-listing-submission";
import {
  NEVER_DISABLED_STANDARD_KEY_SET,
  resolveListingApplicationFields,
  type ApplicationFormVariant,
  type ApplicationConfigSlice,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";

/**
 * The questions of one application in the order the editor draws them. `normalizeCustomApplicationFieldsForEditor`
 * (not the plain normalizer) keeps an in-progress row with an empty label or no options yet, so it stays
 * visible while the manager is still filling it in. The application questions modal and the listing editor's
 * inline Application step both read this, so the two can never order a form differently.
 */
export function orderedEditorApplicationFields(configSlice: ApplicationConfigSlice): ResolvedApplicationField[] {
  const configured = resolveListingApplicationFields(configSlice, normalizeCustomApplicationFieldsForEditor);
  const structural = resolveListingApplicationFields(
    { ...configSlice, questionDisplayOrder: undefined },
    normalizeCustomApplicationFieldsForEditor,
  );
  const configuredPosition = new Map(configured.map((field, index) => [field.id, index]));
  const structuralPosition = new Map(structural.map((field, index) => [field.id, index]));
  return structural.toSorted((left, right) => {
    const section = left.section ?? "additional";
    if (section !== (right.section ?? "additional")) {
      return (structuralPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (structuralPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    }
    const customQuestionsStayAfterBuiltIns = section === "household" || section === "property" || section === "review";
    if (customQuestionsStayAfterBuiltIns && left.isStandard !== right.isStandard) return left.isStandard ? -1 : 1;
    return (configuredPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (configuredPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER);
  });
}

/** Which edits the editor allows on a question: built-in identity, income and household questions stay locked. */
export function canEditBuiltInApplicationField(
  variant: ApplicationFormVariant,
  field: ResolvedApplicationField,
  action: "label" | "required" | "visibility" | "order",
): boolean {
  if (!field.isStandard) return true;
  const key = field.standardKey ?? "";
  if (variant === "cosigner") {
    if (action === "order") return false;
    if (key === "personal-date-of-birth" || key === "personal-social-security-number") return true;
    return action === "label" && (key === "personal-full-legal-name" || key === "personal-phone" || key === "personal-email");
  }
  if (action === "order" && (field.section === "household" || field.section === "property")) return false;
  if (action === "label" && field.section === "household") return false;
  // C195: SSN, ID and income join the identity trio in never being
  // removable — screening/charges/leases read them directly and a manager
  // hiding one breaks approval with no error at disable-time. Unlike the
  // identity trio, only removal is locked here: label and required stay
  // editable (income in particular is meant to stay optional).
  if (action === "visibility" && NEVER_DISABLED_STANDARD_KEY_SET.has(key)) return false;
  if (action !== "order" && (key === "personal-full-legal-name" || key === "personal-phone" || key === "personal-email")) {
    return action === "label";
  }
  return true;
}
