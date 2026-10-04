import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";
import { normalizeCustomApplicationFieldsForEditor } from "@/lib/manager-listing-submission";
import {
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
 * Which edits the editor allows on a question. Every question's text, required flag, choices and type can
 * be edited and every question can be removed, except the few the system reads by key
 * (`NEVER_DISABLED_STANDARD_KEYS`: not removable; `TYPE_LOCKED_STANDARD_KEYS`: type fixed) and the
 * positions the applicant wizard fixes (household and property built-ins, and the whole co-signer form).
 */
export function canEditBuiltInApplicationField(
  variant: ApplicationFormVariant,
  field: ResolvedApplicationField,
  action: "label" | "required" | "visibility" | "order" | "type",
): boolean {
  if (!field.isStandard) return true;
  const key = field.standardKey ?? "";
  if (variant === "cosigner") {
    if (action === "order" || action === "type") return false;
    if (key === "personal-date-of-birth" || key === "personal-social-security-number") return true;
    return action === "label" && (key === "personal-full-legal-name" || key === "personal-phone" || key === "personal-email");
  }
  if (action === "type") return !TYPE_LOCKED_STANDARD_KEY_SET.has(key);
  if (action === "order" && (field.section === "household" || field.section === "property")) return false;
  if (action === "label" && field.section === "household") return false;
  // C195: identity, SSN, ID and income are read directly by screening/charges/leases, so a manager
  // hiding one breaks approval with no error at disable-time. Only removal is locked for SSN, ID,
  // DOB and income; name, phone and email are also always required.
  if (action === "visibility" && NEVER_DISABLED_STANDARD_KEY_SET.has(key)) return false;
  if (action === "required" && (key === "personal-full-legal-name" || key === "personal-phone" || key === "personal-email")) return false;
  return true;
}
