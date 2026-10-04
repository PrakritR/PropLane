"use client";

/**
 * One application's questions, edited in place inside the listing editor's Application step.
 *
 * The same shared question editor the Edit application popup draws (`ApplicationQuestionsEditor`),
 * over the same field operations, but without a modal: each edit returns the template with its DRAFT
 * question config rewritten, and the Application step saves that with the rest of the wizard.
 */
import { useMemo } from "react";
import { ApplicationQuestionsEditor } from "@/components/portal/question-editor/application-questions-editor";
import type { ApplicationEditorState } from "@/components/portal/question-editor/application-question-sections";
import { validateField } from "@/components/portal/application-question-edit-modal";
import { orderedEditorApplicationFields } from "@/lib/application-editor-fields";
import { questionSliceForTemplate, withQuestionSlice } from "@/lib/listing-inline-forms";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  applicationFormVariantForTemplate,
  draftQuestionConfigForTemplate,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import { editorVisibleDisabledApplicationFields } from "@/lib/rental-application/application-field-catalog";

export function InlineApplicationQuestions({
  sub,
  template,
  onTemplate,
}: {
  sub: ManagerListingSubmissionV1;
  template: PropertyApplicationTemplate;
  onTemplate: (next: PropertyApplicationTemplate) => void;
}) {
  const variant = applicationFormVariantForTemplate(template);
  const slice = useMemo(() => questionSliceForTemplate(sub, template), [sub, template]);
  const fields = useMemo(() => orderedEditorApplicationFields(slice), [slice]);
  const disabledFields = useMemo(() => editorVisibleDisabledApplicationFields(variant, slice), [slice, variant]);
  const state = useMemo<ApplicationEditorState>(
    () => ({ slice, disabledSectionIds: draftQuestionConfigForTemplate(template)?.disabledSectionIds ?? [] }),
    [slice, template],
  );

  const fieldErrors = useMemo(() => {
    const used = new Set<string>();
    const errors = new Map<string, string>();
    for (const field of fields) {
      const message = validateField(field, used);
      if (message) errors.set(field.id, message);
    }
    return errors;
  }, [fields]);

  return (
    <div data-attr="listing-v2-application-questions">
      <ApplicationQuestionsEditor
        variant={variant}
        state={state}
        fields={fields}
        disabledFields={disabledFields}
        fieldErrors={fieldErrors}
        dataAttrPrefix="listing-v2-application-editor"
        onState={(next) => {
          const written = withQuestionSlice(template, next.slice);
          onTemplate({
            ...written,
            draftQuestionConfig: written.draftQuestionConfig
              ? {
                  ...written.draftQuestionConfig,
                  // Absent stays absent until a section is switched off.
                  disabledSectionIds:
                    next.disabledSectionIds.length > 0 || written.draftQuestionConfig.disabledSectionIds
                      ? [...next.disabledSectionIds]
                      : undefined,
                }
              : written.draftQuestionConfig,
          });
        }}
      />
    </div>
  );
}
