import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";
import { withDerivedCosignerRule } from "@/lib/application-linked-forms";
import { normalizeCustomApplicationFieldsForEditor } from "@/lib/manager-listing-submission";
import {
  BUILT_IN_ANSWER_VALUES,
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
 * Which edits the editor allows on a question. Nothing is locked: every question's words, type, Required,
 * choices, position and on/off are the manager's to change, built-in or custom, on every form variant
 * (full legal name, email and phone included).
 * Two things are structural rather than locks:
 *  - a built-in whose choices the wizard reads by stored value (`BUILT_IN_ANSWER_VALUES`) can have each choice
 *    reworded, not added, removed or reordered (position i stores value i);
 *  - the property section's choices (property, rooms, lease term) come from the listing, so they are not typed in.
 * Changing the TYPE of a built-in turns it into the manager's own question (see `convertBuiltInQuestion`).
 */
export function canEditBuiltInApplicationField(
  _variant: ApplicationFormVariant,
  field: ResolvedApplicationField,
  action: "label" | "required" | "visibility" | "order" | "type" | "options",
): boolean {
  if (!field.isStandard) return true;
  if (action === "options") return field.section !== "property" || field.options.length > 0;
  return true;
}

/** The questions the editor draws, with a template's co-signer link read as a rule on "Co-signer planned". */
export function editorFieldsWithLinkedForms(
  fields: readonly ResolvedApplicationField[],
  linkedCosignerApplicationTemplateId: string | null | undefined,
): ResolvedApplicationField[] {
  return withDerivedCosignerRule(fields, linkedCosignerApplicationTemplateId);
}

/** True when the choices can be reworded but not added, removed or reordered (the wizard reads their stored values). */
export function builtInAnswersAreFixed(field: Pick<ResolvedApplicationField, "isStandard" | "standardKey">): boolean {
  return Boolean(field.isStandard && field.standardKey && field.standardKey in BUILT_IN_ANSWER_VALUES);
}
