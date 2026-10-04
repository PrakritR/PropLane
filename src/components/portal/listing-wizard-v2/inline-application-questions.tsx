"use client";

/**
 * One application's questions, edited in place inside the listing editor's Application step.
 *
 * The same question rows the application editor modal's Questions step draws
 * (`ApplicationFormBuilder` -> `BuilderQuestionCard`), over the same field operations
 * (`patchListingApplicationField`, `removeListingApplicationField` ...), but without a modal: each
 * edit returns the template with its DRAFT question config rewritten, and the Application step saves
 * that with the rest of the wizard.
 */
import { useMemo, useState } from "react";
import { ApplicationFormBuilder } from "@/components/portal/application-form-builder";
import { validateField } from "@/components/portal/application-question-edit-modal";
import {
  canEditBuiltInApplicationField,
  orderedEditorApplicationFields,
} from "@/lib/application-editor-fields";
import { questionSliceForTemplate, withQuestionSlice } from "@/lib/listing-inline-forms";
import {
  emptyCustomApplicationField,
  type ManagerCustomApplicationField,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { applicationFormVariantForTemplate, type PropertyApplicationTemplate } from "@/lib/property-application-templates";
import {
  addListingApplicationField,
  editorVisibleDisabledApplicationFields,
  moveCustomApplicationFieldToSection,
  patchListingApplicationField,
  reenableListingApplicationField,
  removeListingApplicationField,
  type ApplicationConfigSlice,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";
import { normalizeCustomApplicationFieldsForEditor } from "@/lib/manager-listing-submission";
import type { RentalApplicationSectionId } from "@/lib/rental-application/application-sections";

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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const fieldErrors = useMemo(() => {
    const used = new Set<string>();
    const errors = new Map<string, string>();
    for (const field of fields) {
      const message = validateField(field, used);
      if (message) errors.set(field.id, message);
    }
    return errors;
  }, [fields]);

  const apply = (next: ApplicationConfigSlice) => onTemplate(withQuestionSlice(template, next));
  const canEdit = (field: ResolvedApplicationField, action: "label" | "required" | "visibility" | "order") =>
    canEditBuiltInApplicationField(variant, field, action);

  const patchField = (field: ResolvedApplicationField, patch: Partial<ManagerCustomApplicationField>) => {
    if (
      (patch.label !== undefined && !canEdit(field, "label")) ||
      (patch.required !== undefined && !canEdit(field, "required")) ||
      (patch.options !== undefined && field.isStandard && field.options.length > 0) ||
      (patch.type !== undefined && variant === "cosigner" && !field.isStandard && (patch.type === "file" || patch.type === "photos"))
    ) {
      return;
    }
    apply(patchListingApplicationField(slice, field, patch));
  };

  const canMove = (field: ResolvedApplicationField, direction: "up" | "down"): boolean => {
    if (!canEdit(field, "order")) return false;
    const index = fields.findIndex((candidate) => candidate.id === field.id);
    const neighbor = fields[index + (direction === "up" ? -1 : 1)];
    if (!neighbor || (neighbor.section ?? "additional") !== (field.section ?? "additional")) return false;
    const section = field.section ?? "additional";
    const customStaysAfterBuiltIns = section === "household" || section === "property" || section === "review";
    if (customStaysAfterBuiltIns && field.isStandard !== neighbor.isStandard) return false;
    return canEdit(neighbor, "order");
  };

  const moveField = (field: ResolvedApplicationField, direction: "up" | "down") => {
    if (!canMove(field, direction)) return;
    const index = fields.findIndex((candidate) => candidate.id === field.id);
    const ordered = fields.map((candidate) => candidate.id);
    const target = index + (direction === "up" ? -1 : 1);
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    apply({ ...slice, questionDisplayOrder: ordered });
  };

  const addQuestion = (sectionId: string) => {
    const blank = emptyCustomApplicationField(sectionId);
    apply({ ...slice, ...addListingApplicationField(slice, blank) });
    setExpanded((prev) => new Set(prev).add(blank.id));
  };

  return (
    <div data-attr="listing-v2-application-questions">
      <ApplicationFormBuilder
        applicationFields={fields}
        disabledFields={disabledFields}
        expandedQuestionIds={expanded}
        onToggleExpand={(id) =>
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        fieldErrors={fieldErrors}
        onAddQuestion={addQuestion}
        onRemoveField={(field) => {
          if (canEdit(field, "visibility")) apply(removeListingApplicationField(slice, field));
        }}
        onReenableField={(field) => {
          if (field.standardKey && canEdit(field, "visibility")) apply(reenableListingApplicationField(slice, field.standardKey));
        }}
        onPatchField={patchField}
        onMoveField={moveField}
        onMoveFieldToSection={(field: ResolvedApplicationField, sectionId: RentalApplicationSectionId) => {
          if (field.isStandard) return;
          apply(moveCustomApplicationFieldToSection(slice, field.id, sectionId, normalizeCustomApplicationFieldsForEditor));
        }}
        canMoveField={canMove}
        canEditBuiltIn={canEdit}
        blockedCustomTypes={variant === "cosigner" ? ["file", "photos"] : []}
      />
    </div>
  );
}
