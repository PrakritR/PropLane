/**
 * Application questions <-> the shared question editor. Pure: the host keeps the application's own
 * config slice (the stored shape, unchanged) and this reads it as sections and writes each editor
 * change back through the same catalog functions the form always used.
 *
 * Nothing is locked: every question's words, type, Required, choices, order and on/off can be edited.
 * Changing the type or choices of a built-in retires that built-in and asks a custom question of the new
 * type in its place (a new custom key), so only NEW applications change; a submitted application keeps the
 * answers it already stored. When the system reads that built-in by key (`SYSTEM_READ_ANSWER_STANDARD_KEYS`),
 * the editor confirms first (`systemRead` on the question) and the readers then find the standard key absent.
 */
import {
  CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS,
  emptyCustomApplicationField,
  mintCustomApplicationFieldId,
  type ManagerCustomApplicationField,
  type ManagerCustomApplicationFieldType,
} from "@/lib/manager-listing-submission";
import { builtInAnswersAreFixed, canEditBuiltInApplicationField } from "@/lib/application-editor-fields";
import {
  addListingApplicationField,
  isIdentityFloorStandardKey,
  patchListingApplicationField,
  reenableListingApplicationField,
  removeListingApplicationField,
  systemReadFeatureForStandardKey,
  type ApplicationConfigSlice,
  type ApplicationFormVariant,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";
import {
  RENTAL_APPLICATION_SECTIONS,
  type RentalApplicationSectionId,
} from "@/lib/rental-application/application-sections";
import type {
  QuestionEditorChange,
  QuestionEditorQuestion,
  QuestionEditorSection,
  QuestionEditorType,
} from "./question-editor-types";

/** What the application editor offers a manager (a co-signer cannot be asked for files or photos). */
export function applicationEditorTypes(variant: ApplicationFormVariant): QuestionEditorType[] {
  return CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS.filter(
    (type) => !(variant === "cosigner" && (type.id === "file" || type.id === "photos")),
  ).map((type) => ({ id: type.id, label: type.label }));
}

export type ApplicationEditorState = {
  slice: ApplicationConfigSlice;
  disabledSectionIds: RentalApplicationSectionId[];
};

export type ApplicationEditorContext = {
  variant: ApplicationFormVariant;
  /** Active questions in editor order. */
  fields: readonly ResolvedApplicationField[];
  /** Built-ins currently turned off. */
  disabledFields: readonly ResolvedApplicationField[];
};

const usesChoices = (type: string): boolean => type === "select" || type === "multi_select";
const sectionOf = (field: Pick<ResolvedApplicationField, "section">): string => field.section ?? "additional";

/** The sections the application questions step lists (the Review step asks nothing of its own). */
export const APPLICATION_EDITOR_SECTIONS = RENTAL_APPLICATION_SECTIONS.filter((section) => section.id !== "review");

/** A section holding a question that is always asked (the identity floor: full legal name, email) cannot be switched off. */
export function lockedApplicationSectionIds(
  ctx: Pick<ApplicationEditorContext, "fields" | "disabledFields">,
): RentalApplicationSectionId[] {
  return APPLICATION_EDITOR_SECTIONS.filter((section) =>
    [...ctx.fields, ...ctx.disabledFields].some((field) => sectionOf(field) === section.id && isIdentityFloorStandardKey(field.standardKey)),
  ).map((section) => section.id);
}

function toEditorQuestion(
  field: ResolvedApplicationField,
  variant: ApplicationFormVariant,
  error: string | null | undefined,
  off: boolean,
  siblings: readonly ResolvedApplicationField[],
): QuestionEditorQuestion {
  const can = (action: Parameters<typeof canEditBuiltInApplicationField>[2]) => canEditBuiltInApplicationField(variant, field, action);
  const canType = can("type");
  const feature = field.isStandard ? systemReadFeatureForStandardKey(field.standardKey) : null;
  return {
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    off,
    showIf: field.showIf,
    linkedForms: field.linkedForms,
    systemRead: feature ? { feature } : undefined,
    // A condition only ever depends on another custom question.
    showIfCandidates: field.isStandard
      ? undefined
      : siblings.filter((other) => !other.isStandard && other.id !== field.id).map((other) => ({ key: other.key, label: other.label })),
    error: error ?? null,
    can: {
      label: can("label"),
      required: can("required"),
      type: canType,
      options: can("options"),
      fixedOptions: builtInAnswersAreFixed(field),
      remove: can("visibility"),
      move: can("order"),
    },
  };
}

export function applicationSectionsForEditor(
  ctx: ApplicationEditorContext & {
    disabledSectionIds: readonly RentalApplicationSectionId[];
    fieldErrors?: ReadonlyMap<string, string>;
  },
): QuestionEditorSection[] {
  return APPLICATION_EDITOR_SECTIONS.map((section) => {
    const active = ctx.fields.filter((field) => sectionOf(field) === section.id);
    const activeLabels = new Set(
      active.filter((field) => !field.isStandard).map((field) => field.label.trim().toLowerCase()),
    );
    // A built-in whose type was changed was retired for a custom question of the same words; do not list both.
    const off = ctx.disabledFields.filter(
      (field) => sectionOf(field) === section.id && !activeLabels.has(field.label.trim().toLowerCase()),
    );
    return {
      id: section.id,
      name: section.title,
      enabled: !ctx.disabledSectionIds.includes(section.id),
      questions: [
        ...active.map((field) => toEditorQuestion(field, ctx.variant, ctx.fieldErrors?.get(field.id), false, ctx.fields)),
        ...off.map((field) => toEditorQuestion(field, ctx.variant, null, true, ctx.fields)),
      ],
    };
  });
}

/** Retires a built-in and asks a custom question of the new type, in its place. */
export function convertBuiltInQuestion(
  slice: ApplicationConfigSlice,
  fields: readonly ResolvedApplicationField[],
  field: ResolvedApplicationField,
  patch: Partial<ManagerCustomApplicationField>,
): ApplicationConfigSlice {
  const type = (patch.type ?? field.type) as ManagerCustomApplicationFieldType;
  const options = usesChoices(type)
    ? patch.options ?? (field.options.length > 0 ? [...field.options] : ["Option 1", "Option 2"])
    : [];
  const replacement: ManagerCustomApplicationField = {
    ...emptyCustomApplicationField(field.section ?? "additional"),
    label: patch.label ?? field.label,
    type,
    required: patch.required ?? field.required,
    options,
    linkedForms: patch.linkedForms ?? field.linkedForms,
  };
  const retired = removeListingApplicationField(slice, field);
  const added = addListingApplicationField({ ...slice, ...retired }, replacement);
  const order = fields.map((candidate) => (candidate.id === field.id ? replacement.id : candidate.id));
  return {
    ...slice,
    ...retired,
    ...added,
    applicationConfigMode: "custom",
    questionDisplayOrder: order,
  };
}

/**
 * The new state after one editor change. An unchanged state is returned as the SAME object, so a host
 * can tell that nothing was written (and a no-edit round trip stays byte-for-byte).
 */
export function applyApplicationEditorChange(
  state: ApplicationEditorState,
  change: QuestionEditorChange,
  ctx: ApplicationEditorContext,
): ApplicationEditorState {
  const { slice } = state;
  const canEdit = (field: ResolvedApplicationField, action: Parameters<typeof canEditBuiltInApplicationField>[2]) =>
    canEditBuiltInApplicationField(ctx.variant, field, action);
  const findField = (id: string) => ctx.fields.find((field) => field.id === id) ?? ctx.disabledFields.find((field) => field.id === id);

  switch (change.kind) {
    case "toggle-section": {
      const sectionId = change.sectionId as RentalApplicationSectionId;
      if (!change.enabled && lockedApplicationSectionIds(ctx).includes(sectionId)) return state;
      let next: ApplicationConfigSlice = slice;
      if (!change.enabled) {
        for (const field of ctx.fields) {
          if (sectionOf(field) !== sectionId || !field.isStandard || !canEdit(field, "visibility")) continue;
          next = { ...next, ...removeListingApplicationField(next, field) };
        }
      } else {
        for (const field of ctx.disabledFields) {
          if (sectionOf(field) !== sectionId || !field.standardKey) continue;
          next = { ...next, ...reenableListingApplicationField(next, field.standardKey) };
        }
      }
      return {
        slice: next,
        disabledSectionIds: change.enabled
          ? state.disabledSectionIds.filter((id) => id !== sectionId)
          : state.disabledSectionIds.includes(sectionId)
            ? state.disabledSectionIds
            : [...state.disabledSectionIds, sectionId],
      };
    }
    case "add-section": {
      const next = APPLICATION_EDITOR_SECTIONS.find((section) => state.disabledSectionIds.includes(section.id));
      return next ? applyApplicationEditorChange(state, { kind: "toggle-section", sectionId: next.id, enabled: true }, ctx) : state;
    }
    case "add-question": {
      const blank = emptyCustomApplicationField(change.sectionId);
      return { ...state, slice: { ...slice, ...addListingApplicationField(slice, blank) } };
    }
    case "duplicate-question": {
      const field = findField(change.questionId);
      if (!field) return state;
      const { isStandard: _isStandard, standardKey: _standardKey, ...rest } = field;
      const copy: ManagerCustomApplicationField = {
        ...rest,
        id: mintCustomApplicationFieldId(),
        key: "",
        label: field.label.trim() ? `${field.label.trim()} (copy)` : "",
        options: [...field.options],
        section: field.section ?? "additional",
      };
      const added = addListingApplicationField(slice, copy);
      const order = ctx.fields.flatMap((candidate) => (candidate.id === field.id ? [candidate.id, copy.id] : [candidate.id]));
      return {
        ...state,
        slice: { ...slice, ...added, questionDisplayOrder: order },
      };
    }
    case "delete-question": {
      const field = findField(change.questionId);
      if (!field || !canEdit(field, "visibility")) return state;
      return { ...state, slice: { ...slice, ...removeListingApplicationField(slice, field) } };
    }
    case "restore-question": {
      const field = findField(change.questionId);
      if (!field?.standardKey || !canEdit(field, "visibility")) return state;
      return { ...state, slice: { ...slice, ...reenableListingApplicationField(slice, field.standardKey) } };
    }
    case "edit-question": {
      const field = findField(change.questionId);
      if (!field) return state;
      const patch = change.patch as Partial<ManagerCustomApplicationField>;
      if (
        (patch.label !== undefined && !canEdit(field, "label")) ||
        (patch.required !== undefined && !canEdit(field, "required")) ||
        (patch.type !== undefined && !canEdit(field, "type")) ||
        (patch.options !== undefined && !canEdit(field, "options")) ||
        (patch.type !== undefined && ctx.variant === "cosigner" && (patch.type === "file" || patch.type === "photos"))
      ) {
        return state;
      }
      // A built-in whose choices the wizard reads by stored value keeps every choice; only the wording changes.
      if (patch.options !== undefined && builtInAnswersAreFixed(field) && patch.options.length !== field.options.length) return state;
      const changesShape =
        (patch.type !== undefined && patch.type !== field.type) ||
        (patch.options !== undefined && field.isStandard && !builtInAnswersAreFixed(field));
      if (field.isStandard && changesShape) {
        return { ...state, slice: convertBuiltInQuestion(slice, ctx.fields, field, patch) };
      }
      return { ...state, slice: { ...slice, ...patchListingApplicationField(slice, field, patch) } };
    }
    case "reorder": {
      const inSection = ctx.fields.filter((field) => sectionOf(field) === change.sectionId);
      const byId = new Map(inSection.map((field) => [field.id, field] as const));
      const reordered = change.orderedIds.map((id) => byId.get(id)).filter((field): field is ResolvedApplicationField => Boolean(field));
      if (reordered.length !== inSection.length) return state;
      // Questions the wizard places itself stay where they are; built-ins stay ahead of custom ones in sections that order them so.
      if (inSection.some((field, index) => reordered[index]!.id !== field.id && (!canEdit(field, "order") || !canEdit(reordered[index]!, "order")))) return state;
      const customStaysAfterBuiltIns = change.sectionId === "household" || change.sectionId === "property" || change.sectionId === "review";
      if (customStaysAfterBuiltIns && reordered.some((field, index) => field.isStandard !== inSection[index]!.isStandard)) return state;
      let next = 0;
      const ordered = ctx.fields.map((field) => (sectionOf(field) === change.sectionId ? reordered[next++]!.id : field.id));
      return { ...state, slice: { ...slice, questionDisplayOrder: ordered } };
    }
    default:
      return state;
  }
}
