"use client";

import { type KeyboardEvent } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApplicationQuestionFields } from "@/components/portal/application-question-edit-modal";
import { CustomQuestionField } from "@/components/rental-application/custom-question-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import {
  PortalCollapsibleEditRow,
} from "@/components/portal/portal-collapsible-edit-row";
import type { ManagerCustomApplicationField, ManagerCustomApplicationFieldType } from "@/lib/manager-listing-submission";
import { customApplicationFieldTypeLabel } from "@/lib/manager-listing-submission";
import {
  RENTAL_APPLICATION_SECTIONS,
  type RentalApplicationSection,
  type RentalApplicationSectionId,
} from "@/lib/rental-application/application-sections";
import type { ResolvedApplicationField } from "@/lib/rental-application/application-field-catalog";

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

/** Read-only applicant-facing control preview for one question row (compact / collapsed use). */
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

/** Divider marking where a manager's own questions start, after PropLane's built-ins, in one section. */
function CustomQuestionsDivider() {
  return <p className="px-1 text-xs font-medium text-muted">Your questions appear after PropLane&apos;s.</p>;
}

/**
 * A question mid-edit is normal — the editor deliberately keeps a blank label
 * or an empty option row while the manager is still typing. Guard the display
 * label only; type/options/required stay the REAL unsaved values so the
 * rendered control is still the true applicant control, never a mock.
 */
function previewSafeField(field: ResolvedApplicationField): ResolvedApplicationField {
  return field.label.trim() ? field : { ...field, label: "Untitled question" };
}

/**
 * Live read-only preview of ONE application section, bound to the manager's
 * UNSAVED buffered draft — the entire point of the side pane (see the editor
 * modal's Edit/Preview toggle). Renders the exact same `CustomQuestionField`
 * control the applicant wizard uses, in the section's true order (built-ins
 * first in catalogue order, then custom questions in their persisted array
 * order — already how `applicationFields` is filtered by section). Never
 * writes: `onChange` is a no-op and nothing here can trigger a persist call.
 */
export function ApplicationSectionPreviewPane({
  section,
  fields,
  applicationPreviewPropertyId,
}: {
  section: RentalApplicationSection | null;
  fields: ResolvedApplicationField[];
  /** Resolved by `resolveApplicationPreviewPropertyId` — may be "" (unresolved); never blocks rendering. */
  applicationPreviewPropertyId?: string;
}) {
  return (
    <div
      className="space-y-4 rounded-2xl border border-border bg-accent/10 p-4"
      data-attr="application-preview-pane"
    >
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Applicant sees</p>
        <h3 className="text-sm font-bold text-foreground">{section?.title ?? "Application"}</h3>
      </div>
      {fields.length === 0 ? (
        <p className="text-sm text-muted" data-attr="application-preview-empty">
          No questions in this section yet.
        </p>
      ) : (
        <div className="space-y-4">
          {fields.map((field) => (
            <CustomQuestionField
              key={field.id}
              field={previewSafeField(field)}
              value=""
              onChange={() => {}}
              readOnly
              getApplicationId={() => applicationPreviewPropertyId ?? ""}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BuilderQuestionCard({
  field,
  allFields,
  expanded,
  onToggleExpand,
  error,
  onRemove,
  onPatch,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  availableSections,
  onMoveToSection,
}: {
  field: ResolvedApplicationField;
  /** Every question in the form (all sections), for "Show only if …" candidates. */
  allFields: ResolvedApplicationField[];
  expanded: boolean;
  onToggleExpand: () => void;
  error?: string | null;
  onRemove: () => void;
  onPatch: (patch: Partial<ManagerCustomApplicationField>) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  availableSections: ReadonlyArray<{ id: RentalApplicationSectionId; title: string }>;
  onMoveToSection: (sectionId: RentalApplicationSectionId) => void;
}) {
  // Built-ins are never reorderable — no ⋯ menu for them.
  const showReorderMenu = !field.isStandard;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey || field.isStandard) return;
    if (event.key === "ArrowUp" && canMoveUp) {
      event.preventDefault();
      onMoveUp();
    } else if (event.key === "ArrowDown" && canMoveDown) {
      event.preventDefault();
      onMoveDown();
    }
  };

  const reorderMenu = showReorderMenu ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-label={`Reorder ${field.label.trim() || "question"}`}
          className={RECORD_ACTION_TRIGGER_BUTTON_CLASS}
          data-attr={`application-question-reorder-${field.id}`}
        >
          <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/*
        This menu lives inside the full-page question workspace, which is a
        Modal stacked at z-[70]/z-[71]. The dropdown portals to document.body
        at the default z-50, so it painted BEHIND the workspace: the menu was
        visible but every click landed on whatever row sat on top of it, and
        reordering by mouse silently did nothing. Keyboard reorder (Alt+Arrow)
        never goes through this menu, which is why unit tests passed. Lift it
        above the workspace, matching the z used elsewhere for portalled
        content that must clear a modal. `backdrop` is off because the
        question workspace is itself a full-page editor the manager is
        reordering inside — blurring it under a two-item menu hides the
        rows they are moving.
      */}
      <DropdownMenuContent align="end" backdrop={false} className="z-[10060]">
        <DropdownMenuItem disabled={!canMoveUp} data-attr="application-question-move-up" onSelect={onMoveUp}>
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canMoveDown} data-attr="application-question-move-down" onSelect={onMoveDown}>
          Move down
        </DropdownMenuItem>
        {availableSections.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-attr="application-question-move-to-section">
              Move to section
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="z-[10060]">
              {availableSections.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  data-attr={`application-question-move-to-${s.id}`}
                  onSelect={() => onMoveToSection(s.id)}
                >
                  {s.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <div onKeyDown={onKeyDown}>
      <PortalCollapsibleEditRow
        title={field.label.trim() || "Untitled question"}
        subtitle={`${field.isStandard ? "Built-in" : "Custom"} · ${typeLabel(field.type)}${
          field.required ? " · Required" : " · Optional"
        }`}
        expanded={expanded}
        onExpandedChange={onToggleExpand}
        onRemove={onRemove}
        removeIconOnly
        removeTitle="Remove question"
        removeDataAttr="application-question-remove"
        headerActions={reorderMenu}
        toggleDataAttr={`application-question-edit-${field.id}`}
        error={Boolean(error)}
        contentClassName="space-y-4"
      >
        <ApplicationQuestionFields field={field} onPatch={onPatch} error={error} siblingFields={allFields} />
        <div className="border-t border-border/70 pt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Applicant sees</p>
          {/* The REAL applicant control, read-only — never a hand-drawn imitation, so the
              builder preview and the real wizard can never drift (see the component doc). */}
          <CustomQuestionField field={field} value="" onChange={() => {}} readOnly />
        </div>
      </PortalCollapsibleEditRow>
    </div>
  );
}

/**
 * Application form builder — renders every section, or one section at a time
 * (`activeSectionId`), with each question an in-place expanding row.
 */
export function ApplicationFormBuilder({
  applicationFields,
  disabledFields,
  activeSectionId = null,
  /** When false, the caller supplies its own section title / add-question chrome. */
  showSectionChrome = true,
  expandedQuestionIds,
  onToggleExpand,
  fieldErrors,
  onAddQuestion,
  onRemoveField,
  onReenableField,
  onPatchField,
  onMoveField,
  onMoveFieldToSection,
  canMoveField,
}: {
  applicationFields: ResolvedApplicationField[];
  disabledFields: ResolvedApplicationField[];
  /** When set, only this section is shown (section-by-section wizard). */
  activeSectionId?: RentalApplicationSectionId | null;
  showSectionChrome?: boolean;
  expandedQuestionIds: ReadonlySet<string>;
  onToggleExpand: (fieldId: string) => void;
  fieldErrors?: ReadonlyMap<string, string>;
  onAddQuestion: (sectionId: string) => void;
  onRemoveField: (field: ResolvedApplicationField) => void;
  onReenableField: (field: ResolvedApplicationField) => void;
  onPatchField: (field: ResolvedApplicationField, patch: Partial<ManagerCustomApplicationField>) => void;
  onMoveField?: (field: ResolvedApplicationField, direction: "up" | "down") => void;
  onMoveFieldToSection?: (field: ResolvedApplicationField, sectionId: RentalApplicationSectionId) => void;
  canMoveField?: (field: ResolvedApplicationField, direction: "up" | "down") => boolean;
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

        const firstCustomIndex = sectionQuestions.findIndex((f) => !f.isStandard);
        const availableSections = RENTAL_APPLICATION_SECTIONS.filter((s) => s.id !== section.id).map((s) => ({
          id: s.id,
          title: s.title,
        }));

        return (
          <section key={section.id} className="space-y-3" data-attr={`application-form-section-${section.id}`}>
            {showSectionChrome ? (
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
            ) : null}

            <div className="space-y-2">
              {sectionQuestions.map((field, index) => (
                <div key={field.id} className="space-y-2">
                  {index === firstCustomIndex ? <CustomQuestionsDivider /> : null}
                  <BuilderQuestionCard
                    field={field}
                    allFields={applicationFields}
                    expanded={expandedQuestionIds.has(field.id)}
                    onToggleExpand={() => onToggleExpand(field.id)}
                    error={fieldErrors?.get(field.id) ?? null}
                    onRemove={() => onRemoveField(field)}
                    onPatch={(patch) => onPatchField(field, patch)}
                    canMoveUp={canMoveField ? canMoveField(field, "up") : false}
                    canMoveDown={canMoveField ? canMoveField(field, "down") : false}
                    onMoveUp={() => onMoveField?.(field, "up")}
                    onMoveDown={() => onMoveField?.(field, "down")}
                    availableSections={availableSections}
                    onMoveToSection={(sectionId) => onMoveFieldToSection?.(field, sectionId)}
                  />
                </div>
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
