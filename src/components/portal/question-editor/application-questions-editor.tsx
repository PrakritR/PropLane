"use client";

/**
 * An application's questions in the shared editor. The host owns the config slice and the list of
 * sections switched off; this draws them and hands back the next state for each edit.
 */
import { useMemo } from "react";
import type { ResolvedApplicationField, ApplicationFormVariant } from "@/lib/rental-application/application-field-catalog";
import type { RentalApplicationSectionId } from "@/lib/rental-application/application-sections";
import {
  applicationEditorTypes,
  applicationSectionsForEditor,
  applyApplicationEditorChange,
  lockedApplicationSectionIds,
  type ApplicationEditorState,
} from "./application-question-sections";
import { QuestionSectionsEditor } from "./question-sections-editor";
import type { QuestionEditorChange } from "./question-editor-types";

export function ApplicationQuestionsEditor({
  variant,
  state,
  fields,
  disabledFields,
  fieldErrors,
  onState,
  onRestoreDefaults,
  restoreLabel,
  onSectionOpen,
  onQuestionOpen,
  dataAttrPrefix = "application-questions-editor",
}: {
  variant: ApplicationFormVariant;
  state: ApplicationEditorState;
  fields: readonly ResolvedApplicationField[];
  disabledFields: readonly ResolvedApplicationField[];
  fieldErrors?: ReadonlyMap<string, string>;
  onState: (next: ApplicationEditorState) => void;
  onRestoreDefaults?: () => void;
  restoreLabel?: string;
  onSectionOpen?: (sectionId: RentalApplicationSectionId) => void;
  onQuestionOpen?: (sectionId: RentalApplicationSectionId, questionId: string) => void;
  dataAttrPrefix?: string;
}) {
  const ctx = useMemo(() => ({ variant, fields, disabledFields }), [variant, fields, disabledFields]);
  const sections = useMemo(
    () => applicationSectionsForEditor({ ...ctx, disabledSectionIds: state.disabledSectionIds, fieldErrors }),
    [ctx, state.disabledSectionIds, fieldErrors],
  );
  const handle = (change: QuestionEditorChange) => {
    const next = applyApplicationEditorChange(state, change, ctx);
    if (next !== state) onState(next);
  };
  return (
    <QuestionSectionsEditor
      sections={sections}
      onChange={handle}
      allowedTypes={useMemo(() => applicationEditorTypes(variant), [variant])}
      lockedSectionIds={useMemo(() => lockedApplicationSectionIds(ctx), [ctx])}
      canAddSection={state.disabledSectionIds.length > 0}
      onRestoreDefaults={onRestoreDefaults}
      restoreLabel={restoreLabel}
      onSectionOpen={onSectionOpen ? (id) => onSectionOpen(id as RentalApplicationSectionId) : undefined}
      onQuestionOpen={onQuestionOpen ? (sectionId, id) => onQuestionOpen(sectionId as RentalApplicationSectionId, id) : undefined}
      dataAttrPrefix={dataAttrPrefix}
    />
  );
}
