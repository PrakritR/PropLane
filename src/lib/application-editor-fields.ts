import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";
import { normalizeCustomApplicationFieldsForEditor } from "@/lib/manager-listing-submission";
import {
  BUILT_IN_ANSWER_VALUES,
  NEVER_DISABLED_STANDARD_KEY_SET,
  TYPE_LOCKED_STANDARD_KEY_SET,
  resolveListingApplicationFields,
  type ApplicationFormVariant,
  type ApplicationConfigSlice,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";

const SECTION_RANK = new Map(RENTAL_APPLICATION_SECTIONS.map((section, index) => [section.id as string, index] as const));
function sectionRank(sectionId: string): number {
  return SECTION_RANK.get(sectionId) ?? Number.MAX_SAFE_INTEGER;
}

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
      // Sections keep the applicant's order; comparing across sections by the flat structural position
      // would put a custom question (always last there) after later sections' built-ins and make this
      // comparator inconsistent with the in-section order below.
      const byApplicantOrder = sectionRank(section) - sectionRank(right.section ?? "additional");
      if (byApplicantOrder !== 0) return byApplicantOrder;
      return (structuralPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (structuralPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    }
    const customQuestionsStayAfterBuiltIns = section === "household" || section === "property" || section === "review";
    if (customQuestionsStayAfterBuiltIns && left.isStandard !== right.isStandard) return left.isStandard ? -1 : 1;
    return (configuredPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (configuredPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER);
  });
}

/**
 * Which edits the editor allows on a question. Nothing is locked except what the system cannot work without:
 * a few built-ins cannot be removed (`NEVER_DISABLED_STANDARD_KEYS`), name, phone and email stay required,
 * the type of a built-in the system reads by key is fixed (`TYPE_LOCKED_STANDARD_KEYS`), property and room
 * choices keep their listing-driven options, and the household and property built-ins keep the positions the
 * applicant wizard lays out (the household pair can still swap). Every question's words are editable. A built-in
 * whose choices the wizard reads by stored value (`BUILT_IN_ANSWER_VALUES`) can have each choice reworded.
 */
export function canEditBuiltInApplicationField(
  variant: ApplicationFormVariant,
  field: ResolvedApplicationField,
  action: "label" | "required" | "visibility" | "order" | "type" | "options",
): boolean {
  if (!field.isStandard) return true;
  const key = field.standardKey ?? "";
  if (variant === "cosigner") {
    if (action === "order" || action === "type" || action === "options") return false;
    if (key === "personal-date-of-birth" || key === "personal-social-security-number") return true;
    return action === "label" && (key === "personal-full-legal-name" || key === "personal-phone" || key === "personal-email");
  }
  if (action === "type") return !TYPE_LOCKED_STANDARD_KEY_SET.has(key);
  if (action === "options") return key in BUILT_IN_ANSWER_VALUES || !TYPE_LOCKED_STANDARD_KEY_SET.has(key);
  if (action === "order" && field.section === "property") return false;
  if (action === "visibility" && NEVER_DISABLED_STANDARD_KEY_SET.has(key)) return false;
  if (action === "required" && (key === "personal-full-legal-name" || key === "personal-phone" || key === "personal-email")) return false;
  return true;
}

/** True when the choices can be reworded but not added, removed or reordered (the wizard reads their stored values). */
export function builtInAnswersAreFixed(field: Pick<ResolvedApplicationField, "isStandard" | "standardKey">): boolean {
  return Boolean(field.isStandard && field.standardKey && field.standardKey in BUILT_IN_ANSWER_VALUES);
}
