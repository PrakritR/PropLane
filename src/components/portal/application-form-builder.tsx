"use client";

import { type KeyboardEvent, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { PreviewPager, clampPreviewIndex, packPreviewSteps, previewStepIndexOf, type PreviewGroup } from "@/components/portal/preview-pager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApplicationQuestionFields, type ExtraQuestionType } from "@/components/portal/application-question-edit-modal";
import { CustomQuestionField } from "@/components/rental-application/custom-question-field";
import { isCustomFieldHiddenByCondition, isFileCustomFieldType } from "@/lib/rental-application/custom-fields";
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
import { builtInAnswersAreFixed } from "@/lib/application-editor-fields";
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
 * The application's questions as the preview pager groups them: each listed section in order with
 * only the questions an applicant would see (a conditional question stays hidden until its parent is
 * answered, `isCustomFieldHiddenByCondition`). Exported so the editor can find the step a section is on.
 */
export function applicationPreviewGroups(
  sections: readonly RentalApplicationSection[],
  fields: readonly ResolvedApplicationField[],
  answers: Record<string, string>,
): PreviewGroup<ResolvedApplicationField>[] {
  const answerRows = fields.map((field) => ({ key: field.key, label: field.label, type: field.type, section: field.section, value: answers[field.key] ?? "" }));
  return sections.map((section) => ({
    key: section.id,
    title: section.title,
    items: fields.filter((field) => (field.section ?? "additional") === section.id && !isCustomFieldHiddenByCondition(field, answerRows)),
  }));
}

/**
 * The one decision of which step the pane shows, from the SAME live answers the pane packs its steps
 * from — a step derived from different answers would point at the wrong section. An arrow step the manager took wins, but only while
 * it still exists (deleting questions must not leave the pane pointing past the end); otherwise the
 * step of the focused section, or — when that section draws nothing — of the nearest section that
 * does, forward first and then back, so the preview stays beside what is being edited.
 */
export function applicationPreviewStepAim({
  sections,
  fields,
  answers,
  focusedSectionId,
  stepPick,
}: {
  sections: readonly RentalApplicationSection[];
  fields: readonly ResolvedApplicationField[];
  /** The pane's live preview answers — they decide how the steps pack. */
  answers: Record<string, string>;
  focusedSectionId: string | null;
  /** A step the manager stepped to with the pager arrows; null when nothing has been picked. */
  stepPick: number | null;
}): number {
  const groups = applicationPreviewGroups(sections, fields, answers);
  if (stepPick !== null) return clampPreviewIndex(stepPick, packPreviewSteps(groups).length);
  const stepOf = (sectionId: string) =>
    previewStepIndexOf(groups, (field) => (field.section ?? "additional") === sectionId);
  const from = Math.max(sections.findIndex((section) => section.id === focusedSectionId), 0);
  for (const section of sections.slice(from)) {
    const step = stepOf(section.id);
    if (step >= 0) return step;
  }
  for (const section of sections.slice(0, from).reverse()) {
    const step = stepOf(section.id);
    if (step >= 0) return step;
  }
  return 0;
}

/**
 * Live read-only "Applicant sees" panel, bound to the manager's UNSAVED buffered draft — the entire
 * point of the side pane. It pages through the applicant form in the shared `PreviewPager` (same
 * header, arrows and card as the move-in form editor's "Resident sees"): a step is a whole section,
 * with short consecutive sections combined, each section's title above its questions. Every control
 * is the exact `CustomQuestionField` the applicant wizard uses. Never writes: `onChange` only fills
 * this pane's own state and nothing here can trigger a persist call.
 */
export function ApplicationSectionPreviewPane({
  sections,
  fields,
  formName,
  applicationPreviewPropertyId,
  index,
  onIndexChange,
  answers: controlledAnswers,
  onAnswersChange,
}: {
  /** The sections to page through, in applicant order. */
  sections: readonly RentalApplicationSection[];
  /** Every question of those sections (any order); sections with none draw nothing. */
  fields: readonly ResolvedApplicationField[];
  /** The application's name for the step line; "Application" when it has none yet. */
  formName?: string;
  /** Resolved by `resolveApplicationPreviewPropertyId` — may be "" (unresolved); never blocks rendering. */
  applicationPreviewPropertyId?: string;
  /** Controlled step; omit and the pane keeps its own. */
  index?: number;
  onIndexChange?: (next: number) => void;
  /**
   * Controlled preview answers; omit and the pane keeps its own. A caller that also controls `index`
   * has to own these too — the answers decide how the steps pack.
   */
  answers?: Record<string, string>;
  onAnswersChange?: (next: Record<string, string>) => void;
}) {
  // Answers typed into the preview are never persisted (they only reveal a conditional question the
  // moment its parent is answered, exactly as in the applicant wizard) but they do decide the step
  // packing, so a controlling parent holds them and every pane of one editor shares one set.
  const [ownAnswers, setOwnAnswers] = useState<Record<string, string>>({});
  const answers = controlledAnswers ?? ownAnswers;
  const setAnswer = (key: string, value: string) => {
    const next = { ...answers, [key]: value };
    setOwnAnswers(next);
    onAnswersChange?.(next);
  };
  return (
    <PreviewPager
      heading="Applicant sees"
      ariaLabel="What the applicant sees"
      dataAttr="application-preview-pane"
      attrPrefix="application-preview"
      formName={formName?.trim() || "Application"}
      groups={applicationPreviewGroups(sections, fields, answers)}
      itemKey={(field) => field.id}
      renderItem={(field) => (
        <CustomQuestionField
          field={previewSafeField(field)}
          value={answers[field.key] ?? ""}
          onChange={(next) => setAnswer(field.key, next)}
          // An upload would write to storage; every other control only fills this pane's own state.
          readOnly={isFileCustomFieldType(field.type)}
          getApplicationId={() => applicationPreviewPropertyId ?? ""}
        />
      )}
      emptyText="No questions in this form yet."
      index={index}
      onIndexChange={onIndexChange}
    />
  );
}

export function BuilderQuestionCard({
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
  canEditBuiltIn,
  blockedTypes = [],
  extraTypes = [],
  sampleLabel = "Applicant sees",
  hideSampleForTypes = [],
}: {
  field: ResolvedApplicationField;
  /** Every question in the form (all sections), for "Show only if …" candidates. */
  allFields: ResolvedApplicationField[];
  expanded: boolean;
  onToggleExpand: () => void;
  error?: string | null;
  onRemove?: () => void;
  onPatch: (patch: Partial<ManagerCustomApplicationField>) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  availableSections: ReadonlyArray<{ id: RentalApplicationSectionId; title: string }>;
  onMoveToSection: (sectionId: RentalApplicationSectionId) => void;
  canEditBuiltIn?: (field: ResolvedApplicationField, action: "label" | "required" | "visibility" | "order" | "type" | "options") => boolean;
  blockedTypes?: readonly ManagerCustomApplicationFieldType[];
  /** Types a host form adds beyond the application vocabulary (move-in forms: Photos, Signature). */
  extraTypes?: readonly ExtraQuestionType[];
  /** "Applicant sees" on applications, "Resident sees" on move-in forms. */
  sampleLabel?: string;
  /** Types the read-only sample cannot draw faithfully (a signature pad); the sample is left out for them. */
  hideSampleForTypes?: readonly string[];
}) {
  // Built-in and custom questions share order only where the applicant
  // renderer places their controls in the same ordered section.
  const showReorderMenu = canMoveUp || canMoveDown || (!field.isStandard && availableSections.length > 0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey) return;
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
        subtitle={`${extraTypes.find((extra) => extra.id === field.type)?.label ?? typeLabel(field.type)}${
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
        <ApplicationQuestionFields
          field={field}
          onPatch={onPatch}
          error={error}
          siblingFields={allFields}
          editableLabel={canEditBuiltIn?.(field, "label") ?? true}
          editableRequired={canEditBuiltIn?.(field, "required") ?? true}
          editableType={!field.isStandard}
          editableOptions={builtInAnswersAreFixed(field) ? true : undefined}
          rewordOptions={builtInAnswersAreFixed(field)}
          blockedTypes={blockedTypes}
          extraTypes={extraTypes}
        />
        {hideSampleForTypes.includes(field.type) ? null : (
          <div className="border-t border-border/70 pt-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{sampleLabel}</p>
            {/* The REAL applicant control, read-only — never a hand-drawn imitation, so the
                builder preview and the real wizard can never drift (see the component doc). */}
            <CustomQuestionField field={field} value="" onChange={() => {}} readOnly />
          </div>
        )}
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
  canEditBuiltIn,
  blockedCustomTypes = [],
  onAddSection,
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
  canEditBuiltIn?: (field: ResolvedApplicationField, action: "label" | "required" | "visibility" | "order" | "type" | "options") => boolean;
  blockedCustomTypes?: readonly ManagerCustomApplicationFieldType[];
  /** Full-width footer row to enable another default section (Questions step). */
  onAddSection?: () => void;
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
              {sectionQuestions.map((field) => (
                <div key={field.id} className="space-y-2">
                  <BuilderQuestionCard
                    field={field}
                    allFields={applicationFields}
                    expanded={expandedQuestionIds.has(field.id)}
                    onToggleExpand={() => onToggleExpand(field.id)}
                    error={fieldErrors?.get(field.id) ?? null}
                    onRemove={canEditBuiltIn?.(field, "visibility") === false ? undefined : () => onRemoveField(field)}
                    onPatch={(patch) => onPatchField(field, patch)}
                    canMoveUp={canMoveField ? canMoveField(field, "up") : false}
                    canMoveDown={canMoveField ? canMoveField(field, "down") : false}
                    onMoveUp={() => onMoveField?.(field, "up")}
                    onMoveDown={() => onMoveField?.(field, "down")}
                    availableSections={field.isStandard ? [] : availableSections}
                    onMoveToSection={(sectionId) => onMoveFieldToSection?.(field, sectionId)}
                  canEditBuiltIn={canEditBuiltIn}
                  blockedTypes={blockedCustomTypes}
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
                    disabled={canEditBuiltIn?.(field, "visibility") === false}
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
      {onAddSection && !activeSectionId ? (
        <button
          type="button"
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-card text-sm font-semibold text-primary"
          data-attr="application-add-section"
          onClick={onAddSection}
        >
          + Add section
        </button>
      ) : null}
    </div>
  );
}
