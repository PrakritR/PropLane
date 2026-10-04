/**
 * Move-in form questions <-> the shared question editor. Pure: the host keeps `MoveInFormQuestion[]`
 * (the stored shape, unchanged) and this reads it as sections and writes each editor change back
 * through the same model functions the form always used.
 */
import { CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS } from "@/lib/manager-listing-submission";
import {
  addMoveInQuestion,
  addMoveInSection,
  groupQuestionsBySection,
  removeMoveInQuestion,
  removeMoveInSection,
  renameMoveInSection,
  reorderMoveInSection,
  uniqueQuestionKey,
  updateMoveInQuestion,
} from "@/components/portal/move-in-forms/move-in-form-model";
import type { MoveInFormQuestion } from "@/lib/move-in-forms/types";
import type { QuestionEditorChange, QuestionEditorSection, QuestionEditorType } from "./question-editor-types";

/** The application's answer types plus what only a move-in form asks: Photos, Signature and Acknowledge (a box the resident must tick). */
export const MOVE_IN_EDITOR_TYPES: readonly QuestionEditorType[] = [
  ...CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS.filter((type) => type.id !== "file").map((type) =>
    type.id === "checkbox" ? { id: type.id, label: "Acknowledge" } : { id: type.id, label: type.label },
  ),
  { id: "photos", label: "Photos" },
  { id: "signature", label: "Signature" },
];

/** Sections are identified by position so renaming one never closes it. */
export function moveInSectionId(index: number): string {
  return `s${index}`;
}

export function moveInSectionsForEditor(questions: readonly MoveInFormQuestion[]): QuestionEditorSection[] {
  const sections = groupQuestionsBySection(questions);
  return sections.map((section, index) => ({
    id: moveInSectionId(index),
    name: section.name,
    renamable: true,
    removable: sections.length > 1 || Boolean(section.name),
    questions: section.questions.map((q) => ({
      id: q.id,
      label: q.label,
      type: q.type,
      required: q.required,
      options: q.options,
      showIf: q.showIf,
      showIfCandidates: questions.filter((other) => other.id !== q.id).map((other) => ({ key: other.key, label: other.label })),
      // A signature is always required.
      can: q.type === "signature" ? { required: false } : undefined,
    })),
  }));
}

function sectionNameAt(questions: readonly MoveInFormQuestion[], sectionId: string): string {
  const index = Number(sectionId.slice(1));
  return groupQuestionsBySection(questions)[index]?.name ?? "";
}

export function applyMoveInEditorChange(
  questions: readonly MoveInFormQuestion[],
  change: QuestionEditorChange,
): MoveInFormQuestion[] {
  switch (change.kind) {
    case "add-question":
      return addMoveInQuestion(questions, sectionNameAt(questions, change.sectionId));
    case "add-section":
      return addMoveInSection(questions);
    case "rename-section":
      return renameMoveInSection(questions, sectionNameAt(questions, change.sectionId), change.name);
    case "remove-section":
      return removeMoveInSection(questions, sectionNameAt(questions, change.sectionId));
    case "edit-question":
      return updateMoveInQuestion(questions, change.questionId, change.patch as Parameters<typeof updateMoveInQuestion>[2]);
    case "delete-question":
      return removeMoveInQuestion(questions, change.questionId);
    case "reorder":
      return reorderMoveInSection(questions, sectionNameAt(questions, change.sectionId), change.orderedIds);
    case "duplicate-question": {
      const at = questions.findIndex((q) => q.id === change.questionId);
      if (at < 0) return [...questions];
      const original = questions[at]!;
      const key = uniqueQuestionKey(new Set(questions.map((q) => q.key)), original.label || "question");
      const copy: MoveInFormQuestion = {
        ...structuredClone(original),
        id: `q-${key}`,
        key,
        label: original.label.trim() ? `${original.label.trim()} (copy)` : "",
      };
      const next = [...questions];
      next.splice(at + 1, 0, copy);
      return next;
    }
    default:
      return [...questions];
  }
}
