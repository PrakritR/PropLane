"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApplicationQuestionFields } from "@/components/portal/application-question-edit-modal";
import type { ManagerCustomApplicationField, ManagerCustomApplicationFieldType } from "@/lib/manager-listing-submission";
import { customApplicationFieldTypeLabel } from "@/lib/manager-listing-submission";
import {
  RENTAL_APPLICATION_SECTIONS,
  type RentalApplicationSection,
  type RentalApplicationSectionId,
} from "@/lib/rental-application/application-sections";
import type { ResolvedApplicationField } from "@/lib/rental-application/application-field-catalog";
import { cn } from "@/lib/utils";

function typeLabel(type: ManagerCustomApplicationFieldType): string {
  return customApplicationFieldTypeLabel(type);
}

/** Sections that have at least one active or disabled question. */
export function visibleApplicationFormSections(
  applicationFields: ResolvedApplicationField[],
  disabledFields: ResolvedApplicationField[],
): RentalApplicationSection[] {
  return RENTAL_APPLICATION_SECTIONS.filter((section) => {
    const sectionId = section.id;
    const hasActive = applicationFields.some((f) => (f.section ?? "additional") === sectionId);
    const hasDisabled = disabledFields.some((f) => (f.section ?? "additional") === sectionId);
    return hasActive || hasDisabled;
  });
}

/** Read-only applicant-facing control preview for one question row. */
export function ApplicationFormFieldPreview({ field }: { field: ResolvedApplicationField }) {
  const label = field.label.trim() || "Untitled question";

  if (field.type === "checkbox") {
    return (
      <label className="flex cursor-default items-start gap-3 rounded-xl border border-border bg-accent/20 p-3">
        <span className="mt-0.5 inline-flex size-4 shrink-0 rounded border border-border bg-card" aria-hidden />
        <span className="text-sm text-foreground">
          {label}
          {field.required ? <span className="text-primary"> *</span> : null}
        </span>
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          {label}
          {field.required ? <span className="text-primary"> *</span> : null}
        </p>
        <div className="rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm text-muted">Select an option</div>
      </div>
    );
  }

  if (field.type === "photos" || field.type === "file") {
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          {label}
          {field.required ? <span className="text-primary"> *</span> : null}
        </p>
        <div className="flex min-h-[4.5rem] items-center justify-center rounded-xl border border-dashed border-border bg-accent/20 px-4 text-xs text-muted">
          {field.type === "photos" ? "Photo upload" : "File upload"}
        </div>
      </div>
    );
  }

  const inputType = field.type === "date" ? "date" : field.type === "number" ? "number" : "text";

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-foreground">
        {label}
        {field.required ? <span className="text-primary"> *</span> : null}
      </p>
      <Input
        type={inputType}
        disabled
        placeholder={field.type === "date" ? "mm/dd/yyyy" : "Short answer text"}
        className="bg-card opacity-100"
      />
    </div>
  );
}

function BuilderQuestionCard({
  field,
  expanded,
  onRemove,
  onPatch,
}: {
  field: ResolvedApplicationField;
  expanded: boolean;
  onRemove: () => void;
  onPatch: (patch: Partial<ManagerCustomApplicationField>) => void;
}) {
  const [optionsText, setOptionsText] = useState(field.options.join(", "));

  useEffect(() => {
    setOptionsText(field.options.join(", "));
  }, [field.id, field.options]);

  const onOptionsTextChange = (text: string) => {
    setOptionsText(text);
    const options = text
      .split(/[\n,]/)
      .map((part) => part.trim())
      .filter(Boolean);
    onPatch({ options });
  };

  return (
    <article
      data-attr={`application-form-question-${field.id}`}
      className={cn(
        "rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-sm)] sm:p-5",
        expanded && "ring-1 ring-primary/15",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {field.isStandard ? "Built-in" : "Custom"} · {typeLabel(field.type)}
        </p>
        <Button
          type="button"
          variant="outline"
          className="h-7 rounded-full px-2.5 text-xs"
          data-attr="application-question-remove"
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>

      {expanded ? (
        <div className="space-y-4">
          <ApplicationQuestionFields
            field={field}
            optionsText={optionsText}
            onPatch={onPatch}
            onOptionsTextChange={onOptionsTextChange}
          />
          <div className="border-t border-border/70 pt-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Preview</p>
            <ApplicationFormFieldPreview field={field} />
          </div>
        </div>
      ) : (
        <ApplicationFormFieldPreview field={field} />
      )}
    </article>
  );
}

/**
 * Application form builder — all sections, or one section at a time with every question expanded for editing.
 */
export function ApplicationFormBuilder({
  applicationFields,
  disabledFields,
  activeSectionId = null,
  alwaysExpandQuestions = false,
  onAddQuestion,
  onRemoveField,
  onReenableField,
  onPatchField,
}: {
  applicationFields: ResolvedApplicationField[];
  disabledFields: ResolvedApplicationField[];
  /** When set, only this section is shown (section-by-section wizard). */
  activeSectionId?: RentalApplicationSectionId | null;
  /** When true, every question shows inline edit controls (no click-to-expand). */
  alwaysExpandQuestions?: boolean;
  onAddQuestion: (sectionId: string) => void;
  onRemoveField: (field: ResolvedApplicationField) => void;
  onReenableField: (field: ResolvedApplicationField) => void;
  onPatchField: (field: ResolvedApplicationField, patch: Partial<ManagerCustomApplicationField>) => void;
}) {
  const sectionsToRender = activeSectionId
    ? RENTAL_APPLICATION_SECTIONS.filter((section) => section.id === activeSectionId)
    : RENTAL_APPLICATION_SECTIONS;

  return (
    <div className="space-y-6" data-slot="application-form-builder">
      {sectionsToRender.map((section) => {
        const sectionQuestions = applicationFields.filter((f) => (f.section ?? "additional") === section.id);
        const sectionDisabled = disabledFields.filter((f) => (f.section ?? "additional") === section.id);
        if (sectionQuestions.length === 0 && sectionDisabled.length === 0) return null;

        return (
          <section key={section.id} className="space-y-3" data-attr={`application-form-section-${section.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-foreground">{section.title}</h3>
              <Button
                type="button"
                variant="outline"
                className="h-8 rounded-full px-3 text-xs"
                data-attr="application-questions-add"
                onClick={() => onAddQuestion(section.id)}
              >
                + Add question
              </Button>
            </div>

            <div className="space-y-3">
              {sectionQuestions.map((field) => (
                <BuilderQuestionCard
                  key={field.id}
                  field={field}
                  expanded={alwaysExpandQuestions}
                  onRemove={() => onRemoveField(field)}
                  onPatch={(patch) => onPatchField(field, patch)}
                />
              ))}

              {sectionDisabled.map((field) => (
                <div
                  key={field.id}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-border bg-accent/15 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-muted line-through">
                      {field.label.trim() || "Untitled question"}
                    </p>
                    <p className="text-xs text-muted/80">Off · not asked on this application</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-7 shrink-0 rounded-full px-2.5 text-xs"
                    data-attr="application-question-reenable"
                    onClick={() => onReenableField(field)}
                  >
                    Add back
                  </Button>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
