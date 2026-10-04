"use client";

/**
 * A move-in form's questions, edited in the shared question editor (the same one Edit application
 * draws), so a question is edited the same way on both forms. The move-in form editor modal's
 * Questions step and the listing editor's inline Move-in step both draw this component.
 */
import { useMemo } from "react";
import {
  applyMoveInEditorChange,
  MOVE_IN_EDITOR_TYPES,
  moveInSectionsForEditor,
} from "@/components/portal/question-editor/move-in-question-sections";
import { QuestionSectionsEditor } from "@/components/portal/question-editor/question-sections-editor";
import type { MoveInFormQuestion } from "@/lib/move-in-forms/types";

export function MoveInQuestionsEditor({
  questions,
  onChange,
  onFocusQuestion,
}: {
  questions: MoveInFormQuestion[];
  onChange: (next: MoveInFormQuestion[]) => void;
  /** The modal points its live preview at the question being edited. */
  onFocusQuestion?: (key: string) => void;
}) {
  const sections = useMemo(() => moveInSectionsForEditor(questions), [questions]);
  return (
    <QuestionSectionsEditor
      sections={sections}
      allowedTypes={MOVE_IN_EDITOR_TYPES}
      onChange={(change) => onChange(applyMoveInEditorChange(questions, change))}
      onQuestionOpen={(_sectionId, questionId) => {
        const key = questions.find((question) => question.id === questionId)?.key;
        if (key) onFocusQuestion?.(key);
      }}
      dataAttrPrefix="move-in-questions-editor"
    />
  );
}
