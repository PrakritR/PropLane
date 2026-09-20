"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ApplicationFormBuilder, ApplicationSectionPreviewPane } from "@/components/portal/application-form-builder";
import { sanitizeCustomApplicationFieldsForSave, validateField } from "@/components/portal/application-question-edit-modal";
import {
  PORTAL_EDIT_ROW_ICON_BUTTON_CLASS,
} from "@/components/portal/portal-collapsible-edit-row";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  customApplicationFieldTypeLabel,
  emptyCustomApplicationField,
  normalizeCustomApplicationFieldsForEditor,
  type ManagerCustomApplicationField,
  type ManagerCustomApplicationFieldType,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  applicationConfigFieldsFromSubmission,
  persistApplicationConfigToPropertyIdsOnServer,
  persistManagerListingSubmissionOnServer,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import {
  addListingApplicationField,
  applicationConfigForVariant,
  canMoveCustomApplicationField,
  customApplicationConfigWithAllStandardQuestions,
  mergeApplicationConfigForVariant,
  moveCustomApplicationField,
  moveCustomApplicationFieldToSection,
  patchListingApplicationField,
  reenableListingApplicationField,
  removeListingApplicationField,
  editorVisibleDisabledApplicationFields,
  resolveListingApplicationFields,
  restoreDefaultApplicationConfig,
  type ApplicationConfigSlice,
  type ApplicationFormVariant,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";
import { RENTAL_APPLICATION_SECTIONS, type RentalApplicationSectionId } from "@/lib/rental-application/application-sections";
import {
  APPLICATION_QUESTION_PACKS,
  buildQuestionsFromPack,
} from "@/lib/rental-application/application-question-packs";
import { useConfirm } from "@/components/providers/app-ui-provider";
import {
  createPropertyApplicationTemplate,
  withPropertyApplicationTemplatesExplicit,
  updatePropertyApplicationTemplate,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";

/** Question sections start collapsed; managers expand the ones they need. */
function collapsedApplicationSections(): Set<string> {
  return new Set();
}

const APPLICATION_FORM_VARIANTS: ReadonlyArray<{ id: ApplicationFormVariant; label: string; hint: string }> = [
  { id: "standard", label: "Long-term lease", hint: "The full application for standard leases." },
  {
    id: "short_term",
    label: "Short-term stay",
    hint: "A shorter guest application for short-term stays — configured separately.",
  },
  {
    id: "cosigner",
    label: "Co-signer",
    hint: "The co-signer form linked to a primary applicant — configured separately.",
  },
];

function typeLabel(type: ManagerCustomApplicationFieldType): string {
  return customApplicationFieldTypeLabel(type);
}

export { typeLabel as applicationQuestionTypeLabel };

async function persistApplicationConfig({
  next,
  saveTarget,
  propertyIds,
  managerUserId,
  showToast,
  singleSuccessMessage,
}: {
  next: ManagerListingSubmissionV1;
  saveTarget?: ManagerPropertySaveTarget;
  propertyIds?: string[];
  managerUserId: string;
  showToast: (m: string) => void;
  singleSuccessMessage: string;
}): Promise<boolean> {
  const bulkIds = propertyIds?.filter((id) => id.trim()) ?? [];
  if (bulkIds.length > 0) {
    const { saved, failed } = await persistApplicationConfigToPropertyIdsOnServer(
      managerUserId,
      bulkIds,
      applicationConfigFieldsFromSubmission(next),
    );
    if (saved === 0) {
      showToast("Could not save application settings.");
      return false;
    }
    if (failed > 0) {
      showToast(`Updated application for ${saved} properties (${failed} could not be saved).`);
    } else if (saved === 1) {
      showToast(singleSuccessMessage);
    } else {
      showToast(`Updated application for ${saved} properties`);
    }
    return true;
  }

  if (!saveTarget) {
    showToast("Could not save application settings.");
    return false;
  }
  if (!(await persistManagerListingSubmissionOnServer(saveTarget, managerUserId, next))) {
    showToast("Could not save application settings.");
    return false;
  }
  showToast(singleSuccessMessage);
  return true;
}

function submissionForNewCustomApplication(sub: ManagerListingSubmissionV1): ManagerListingSubmissionV1 {
  return {
    ...sub,
    ...mergeApplicationConfigForVariant("standard", customApplicationConfigWithAllStandardQuestions()),
  };
}

/** The pack offered pre-selected in the ADD flow. */
const RECOMMENDED_QUESTION_PACK = APPLICATION_QUESTION_PACKS.find((p) => p.recommended) ?? null;

/** Shared application-question editor — one full-page workspace, property templates and bulk Applications edit. */
export function ManagerApplicationQuestionsEditorModal({
  open,
  title = "Application",
  sub,
  saveTarget,
  propertyIds,
  managerUserId,
  applicationPreviewPropertyId,
  initialVariant = "standard",
  lockVariant = false,
  templateEditorMode,
  applicationTemplate = null,
  templates,
  onPersistSubmission,
  onDelete,
  canDelete = false,
  onClose,
  onSaved,
  showToast,
}: {
  open: boolean;
  title?: string;
  sub: ManagerListingSubmissionV1;
  saveTarget?: ManagerPropertySaveTarget;
  /** When set, each save applies the same application config to every id (bulk edit). */
  propertyIds?: string[];
  managerUserId: string;
  /**
   * Property the Preview pane's applicant control binds to — resolved by the
   * caller via `resolveApplicationPreviewPropertyId` (it needs `listingId`,
   * which this modal does not itself receive). May be "" when unresolved;
   * the pane still renders the questions, it just never blocks on it.
   */
  applicationPreviewPropertyId?: string;
  /** Which stay-type form opens first (long-term vs short-term). */
  initialVariant?: ApplicationFormVariant;
  /** Property detail row edit — one stay type only; hide the long-term / short-term switcher. */
  lockVariant?: boolean;
  /** Property tab — add or edit a named application on one page with questions below the name. */
  templateEditorMode?: "add" | "edit";
  applicationTemplate?: PropertyApplicationTemplate | null;
  templates?: PropertyApplicationTemplate[];
  onPersistSubmission?: (
    merged: ManagerListingSubmissionV1,
    opts: { message: string },
  ) => boolean | Promise<boolean>;
  /** Property template edit — removes the application (defaults show Delete but toast on click). */
  onDelete?: () => void;
  /** Mirrors lease modal — Delete is shown only when more than one template exists. */
  canDelete?: boolean;
  onClose: () => void;
  onSaved: () => void;
  showToast: (m: string) => void;
}) {
  const isTemplateEditor = templateEditorMode === "add" || templateEditorMode === "edit";
  const [localSub, setLocalSub] = useState(sub);
  const [variant, setVariant] = useState<ApplicationFormVariant>("standard");
  const [templateLabel, setTemplateLabel] = useState("");
  const [templateLabelError, setTemplateLabelError] = useState<string | null>(null);
  const [expandedSectionIds, setExpandedSectionIds] = useState<Set<string>>(() => new Set());
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<Set<string>>(() => new Set());
  // The ADD flow's template chooser — which section it targets, or null when closed.
  const [addChooserSectionId, setAddChooserSectionId] = useState<string | null>(null);
  const [addChoice, setAddChoice] = useState<string>(RECOMMENDED_QUESTION_PACK?.id ?? "blank");
  const [stepIdx, setStepIdx] = useState(0);
  // Round 31: every edit stays local until an explicit Save. `dirty` gates the Save button
  // and drives the discard confirmation so a stray click can never overwrite properties.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const baseSub = templateEditorMode === "add" ? submissionForNewCustomApplication(sub) : sub;
    setLocalSub(baseSub);
    setVariant(templateEditorMode === "add" ? "standard" : initialVariant);
    setTemplateLabel(applicationTemplate?.label ?? "");
    setTemplateLabelError(null);
    setExpandedSectionIds(collapsedApplicationSections());
    setExpandedQuestionIds(new Set());
    setAddChooserSectionId(null);
    setAddChoice(RECOMMENDED_QUESTION_PACK?.id ?? "blank");
    setStepIdx(0);
    setDirty(templateEditorMode === "add");
    setSaving(false);
    setSaveError(null);
  }, [open, sub, initialVariant, templateEditorMode, applicationTemplate]);

  const bulkIds = propertyIds?.filter((id) => id.trim()) ?? [];
  const isBulkSave = bulkIds.length > 0;
  const showDelete = templateEditorMode === "edit" && canDelete && Boolean(onDelete);
  const confirm = useConfirm();

  const handleDelete = async () => {
    if (!showDelete || !onDelete) return;
    if (!(await confirm({ description: "Delete this application?" }))) return;
    onDelete();
  };

  // The config slice for the form the manager is editing.
  // top-level triplet; short-term reads its own, defaulting to PropLane's
  // curated short-term question set until edited. Edits to one never touch the
  // other.
  const configSlice = useMemo(() => applicationConfigForVariant(localSub, variant), [localSub, variant]);

  // `normalizeCustomApplicationFieldsForEditor` (not the plain normalizer) keeps
  // an in-progress row with an empty label or no options yet — it must stay
  // visible IN PLACE while the manager is still filling it in, not vanish on
  // every re-render before Save.
  const applicationFields = useMemo(
    () => resolveListingApplicationFields(configSlice, normalizeCustomApplicationFieldsForEditor),
    [configSlice],
  );
  const disabledFields = useMemo(
    () => editorVisibleDisabledApplicationFields(variant, configSlice),
    [configSlice, variant],
  );

  // Inline per-row validation (duplicate key, empty label, options required) —
  // the old per-question modal's `validateField` run once per field in
  // question order, so the SECOND row to claim a key is the one flagged.
  const fieldErrors = useMemo(() => {
    const usedKeys = new Set<string>();
    const errors = new Map<string, string>();
    for (const f of applicationFields) {
      const err = validateField(f, usedKeys);
      if (err) errors.set(f.id, err);
    }
    return errors;
  }, [applicationFields]);
  const hasFieldErrors = fieldErrors.size > 0;

  // The Preview pane targets ONE section. It follows whichever section is open
  // in the editor until the manager picks one in the pane itself — on a phone
  // the editor list is hidden behind the preview, so the pane has to be able to
  // walk the sections on its own (dropdown + Previous / Next).
  const [previewSectionPick, setPreviewSectionPick] = useState<RentalApplicationSectionId | null>(null);
  const previewSectionId = useMemo((): RentalApplicationSectionId | null => {
    if (previewSectionPick) return previewSectionPick;
    const openSection = RENTAL_APPLICATION_SECTIONS.find((s) => expandedSectionIds.has(s.id));
    if (openSection) return openSection.id;
    const firstWithQuestions = RENTAL_APPLICATION_SECTIONS.find((s) =>
      applicationFields.some((f) => (f.section ?? "additional") === s.id),
    );
    return (firstWithQuestions ?? RENTAL_APPLICATION_SECTIONS[0])?.id ?? null;
  }, [previewSectionPick, expandedSectionIds, applicationFields]);
  const previewSectionIndex = RENTAL_APPLICATION_SECTIONS.findIndex((s) => s.id === previewSectionId);
  const stepPreviewSection = (delta: number) => {
    const next = RENTAL_APPLICATION_SECTIONS[previewSectionIndex + delta];
    if (next) setPreviewSectionPick(next.id);
  };
  const previewSection = useMemo(
    () => RENTAL_APPLICATION_SECTIONS.find((s) => s.id === previewSectionId) ?? null,
    [previewSectionId],
  );
  const previewFields = useMemo(
    () => applicationFields.filter((f) => (f.section ?? "additional") === previewSectionId),
    [applicationFields, previewSectionId],
  );

  const workspaceSteps = useMemo<AddWorkspaceStep[]>(() => {
    const questionSummary = (sectionId: string) => {
      const n = applicationFields.filter((f) => (f.section ?? "additional") === sectionId).length;
      return n === 1 ? "1 question" : `${n} questions`;
    };
    const head: AddWorkspaceStep[] = isTemplateEditor
      ? [{ id: "name", label: "Name", incomplete: !templateLabel.trim(), summary: templateLabel.trim() || "Name this application" }]
      : lockVariant
        ? []
        : [{ id: "form", label: "Form", summary: APPLICATION_FORM_VARIANTS.find((v) => v.id === variant)?.label ?? "Form" }];
    return [
      ...head,
      ...RENTAL_APPLICATION_SECTIONS.map((section) => ({
        id: section.id,
        label: section.title,
        summary: questionSummary(section.id),
      })),
      { id: "preview", label: "Preview", summary: "What the applicant sees" },
    ];
  }, [applicationFields, isTemplateEditor, lockVariant, templateLabel, variant]);

  const current = Math.min(stepIdx, workspaceSteps.length - 1);
  const stepId = workspaceSteps[current]?.id ?? "preview";

  // Apply an edit to LOCAL state only — nothing is persisted until Save.
  const applySlice = (nextSlice: ApplicationConfigSlice): void => {
    setLocalSub((prev) => ({ ...prev, ...mergeApplicationConfigForVariant(variant, nextSlice) }));
    setDirty(true);
  };

  // An EDIT to the short-term form must STICK even when it leaves the slice
  // empty — e.g. re-enabling every off-by-default built-in, or deleting the last
  // custom question after doing so. `applicationConfigForVariant` treats a
  // non-"custom" short-term slice as the curated DEFAULT, so a mode that
  // collapsed to "standard" would silently revert the manager's choices. Pin
  // "custom" on edits; only "Restore PropLane defaults" (plain `applySlice`
  // with a fresh default) intentionally returns short-term to the curated set.
  const applyEditedSlice = (nextSlice: ApplicationConfigSlice): void =>
    applySlice(
      variant === "short_term" || variant === "cosigner" || templateEditorMode === "add" || templateEditorMode === "edit"
        ? { ...nextSlice, applicationConfigMode: "custom" }
        : nextSlice,
    );

  const commitSave = async () => {
    if (isTemplateEditor) {
      const trimmed = templateLabel.trim();
      if (!trimmed) {
        setTemplateLabelError("Enter a name for this application.");
        return;
      }
      setTemplateLabelError(null);
      if (!templates || !onPersistSubmission) {
        showToast("Could not save application.");
        return;
      }
    }

    if (isBulkSave) {
      const ok = await confirm({
        title: "Apply to properties",
        description: `Apply these application settings to ${bulkIds.length} properties?`,
        note: "Existing per-property differences will be replaced.",
        confirmLabel: "Apply",
        tone: "primary",
      });
      if (!ok) return;
    }
    setSaving(true);

    // Drop blank option rows / case-insensitive duplicates across every
    // variant's custom questions before anything is persisted.
    const sanitizedSub: ManagerListingSubmissionV1 = {
      ...localSub,
      customApplicationFields: sanitizeCustomApplicationFieldsForSave(localSub.customApplicationFields ?? []),
      shortTermCustomApplicationFields: sanitizeCustomApplicationFieldsForSave(
        localSub.shortTermCustomApplicationFields ?? [],
      ),
      cosignerCustomApplicationFields: sanitizeCustomApplicationFieldsForSave(
        localSub.cosignerCustomApplicationFields ?? [],
      ),
    };

    if (isTemplateEditor && templates && onPersistSubmission) {
      const trimmed = templateLabel.trim();
      let nextTemplates: PropertyApplicationTemplate[];
      if (templateEditorMode === "add") {
        nextTemplates = [
          ...templates,
          createPropertyApplicationTemplate({ kind: "long-term", label: trimmed }),
        ];
      } else {
        nextTemplates = updatePropertyApplicationTemplate(templates, applicationTemplate!.id, {
          label: trimmed,
        });
      }
      const merged = withPropertyApplicationTemplatesExplicit(sanitizedSub, nextTemplates);
      const okSaved = await onPersistSubmission(merged, {
        message: templateEditorMode === "add" ? "Application added." : "Application saved.",
      });
      setSaving(false);
      if (!okSaved) {
        setSaveError("Could not save. Your changes are still here — try again.");
        return;
      }
      setSaveError(null);
      setDirty(false);
      onSaved();
      onClose();
      return;
    }

    const okSaved = await persistApplicationConfig({
      next: sanitizedSub,
      saveTarget,
      propertyIds: isBulkSave ? bulkIds : undefined,
      managerUserId,
      showToast,
      singleSuccessMessage: "Application settings saved.",
    });
    setSaving(false);
    if (!okSaved) {
      setSaveError("Could not save. Your changes are still here — try again.");
      return;
    }
    setSaveError(null);
    setDirty(false);
    onSaved();
    onClose();
  };

  const jump = (index: number) => {
    setStepIdx(index);
    const id = workspaceSteps[index]?.id;
    if (id && RENTAL_APPLICATION_SECTIONS.some((section) => section.id === id)) {
      setPreviewSectionPick(id as RentalApplicationSectionId);
    }
  };

  const removeField = (field: ResolvedApplicationField) => {
    applyEditedSlice(removeListingApplicationField(configSlice, field));
  };

  const reenableField = (field: ResolvedApplicationField) => {
    if (!field.standardKey) return;
    applyEditedSlice(reenableListingApplicationField(configSlice, field.standardKey));
  };

  const patchField = (field: ResolvedApplicationField, patch: Partial<ManagerCustomApplicationField>) => {
    applyEditedSlice(patchListingApplicationField(configSlice, field, patch));
  };

  const toggleQuestionExpand = (fieldId: string) => {
    setExpandedQuestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(fieldId)) next.delete(fieldId);
      else next.add(fieldId);
      return next;
    });
  };

  const canMoveField = (field: ResolvedApplicationField, direction: "up" | "down"): boolean => {
    if (field.isStandard) return false;
    return canMoveCustomApplicationField(configSlice, field.id, direction, normalizeCustomApplicationFieldsForEditor);
  };

  const moveField = (field: ResolvedApplicationField, direction: "up" | "down"): void => {
    if (field.isStandard) return;
    applyEditedSlice(moveCustomApplicationField(configSlice, field.id, direction, normalizeCustomApplicationFieldsForEditor));
  };

  const moveFieldToSection = (field: ResolvedApplicationField, sectionId: RentalApplicationSectionId): void => {
    if (field.isStandard) return;
    applyEditedSlice(
      moveCustomApplicationFieldToSection(configSlice, field.id, sectionId, normalizeCustomApplicationFieldsForEditor),
    );
    setExpandedSectionIds((prev) => new Set(prev).add(sectionId));
  };

  const openAddChooser = (sectionId: string) => {
    setAddChooserSectionId(sectionId);
    setAddChoice(RECOMMENDED_QUESTION_PACK?.id ?? "blank");
    setExpandedSectionIds((prev) => new Set(prev).add(sectionId));
  };

  const confirmAddChoice = () => {
    const sectionId = addChooserSectionId;
    if (!sectionId) return;

    if (addChoice === "blank") {
      // `emptyCustomApplicationField` already returns a raw ManagerCustomApplicationField
      // (no `isStandard`/`standardKey`) — store it as-is, not wrapped as a ResolvedApplicationField.
      const blank = emptyCustomApplicationField(sectionId);
      applyEditedSlice({ ...configSlice, ...addListingApplicationField(configSlice, blank) });
      setExpandedQuestionIds((prev) => new Set(prev).add(blank.id));
    } else {
      const pack = APPLICATION_QUESTION_PACKS.find((p) => p.id === addChoice);
      if (pack) {
        // Every existing question key in the slice — passing the wrong set
        // here produces duplicate answer keys that silently collide.
        const takenKeys = applicationFields.map((f) => f.key);
        const built = buildQuestionsFromPack(pack, takenKeys).map((f) => ({ ...f, section: sectionId }));
        let nextConfig: { customApplicationFields: ManagerCustomApplicationField[]; applicationConfigMode: "custom" } = {
          customApplicationFields: configSlice.customApplicationFields,
          applicationConfigMode: "custom",
        };
        for (const f of built) nextConfig = addListingApplicationField(nextConfig, f);
        applyEditedSlice({ ...configSlice, ...nextConfig });
        setExpandedQuestionIds((prev) => {
          const next = new Set(prev);
          for (const f of built) next.add(f.id);
          return next;
        });
      }
    }
    setAddChooserSectionId(null);
  };

  const restoreDefaults = () => {
    if (isTemplateEditor) {
      const isCustomTemplate =
        templateEditorMode === "add" || (applicationTemplate != null && !applicationTemplate.listingSeedKey);
      if (isCustomTemplate) {
        applySlice(customApplicationConfigWithAllStandardQuestions());
      } else if (variant === "short_term") {
        applySlice({
          ...applicationConfigForVariant({} as ManagerListingSubmissionV1, "short_term"),
          applicationConfigMode: "standard",
        });
      } else if (variant === "cosigner") {
        applySlice({
          ...applicationConfigForVariant({} as ManagerListingSubmissionV1, "cosigner"),
          applicationConfigMode: "standard",
        });
      } else {
        applySlice(restoreDefaultApplicationConfig());
      }
      setExpandedSectionIds(collapsedApplicationSections());
      return;
    }
    applySlice(restoreDefaultApplicationConfig());
    setExpandedSectionIds(collapsedApplicationSections());
  };

  const sectionAddButton = (sectionId: string) => (
    <button
      type="button"
      className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
      title="Add question"
      aria-label="Add question"
      data-attr="application-questions-add"
      onClick={() => openAddChooser(sectionId)}
    >
      <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden />
    </button>
  );

  const restoreLabel =
    isTemplateEditor && (templateEditorMode === "add" || (applicationTemplate != null && !applicationTemplate.listingSeedKey))
      ? "Reset all standard questions"
      : "Restore PropLane defaults";

  const renderSection = (sectionId: RentalApplicationSectionId) => {
    const sectionQuestions = applicationFields.filter((f) => (f.section ?? "additional") === sectionId);
    const sectionDisabled = disabledFields.filter((f) => (f.section ?? "additional") === sectionId);
    return (
      <div data-attr={`application-section-toggle-${sectionId}`}>
        {sectionQuestions.length === 0 && sectionDisabled.length === 0 ? (
          <p className="text-sm text-muted">No questions in this section yet.</p>
        ) : (
          <ApplicationFormBuilder
            applicationFields={applicationFields}
            disabledFields={disabledFields}
            activeSectionId={sectionId}
            showSectionChrome={false}
            expandedQuestionIds={expandedQuestionIds}
            onToggleExpand={toggleQuestionExpand}
            fieldErrors={fieldErrors}
            onAddQuestion={openAddChooser}
            onRemoveField={removeField}
            onReenableField={reenableField}
            onPatchField={patchField}
            onMoveField={moveField}
            onMoveFieldToSection={moveFieldToSection}
            canMoveField={canMoveField}
          />
        )}
      </div>
    );
  };

  const previewBody = (
    <div className="space-y-3">
      <FieldSingleSelect
        label="Section"
        labelClassName={WIZARD_LABEL_CLASS}
        value={previewSectionId ?? ""}
        options={RENTAL_APPLICATION_SECTIONS.map((section) => ({
          value: section.id,
          label: `${section.title} · ${applicationFields.filter((f) => (f.section ?? "additional") === section.id).length} questions`,
        }))}
        onChange={(next) => setPreviewSectionPick(next as RentalApplicationSectionId)}
        dataAttr="application-preview-section"
      />
      <ApplicationSectionPreviewPane
        section={previewSection}
        fields={previewFields}
        applicationPreviewPropertyId={applicationPreviewPropertyId}
      />
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          disabled={previewSectionIndex <= 0}
          data-attr="application-preview-previous"
          onClick={() => stepPreviewSection(-1)}
        >
          ‹ Previous
        </Button>
        <span className="text-xs text-muted" data-attr="application-preview-position">
          {previewSectionIndex + 1} of {RENTAL_APPLICATION_SECTIONS.length}
        </span>
        <Button
          type="button"
          variant="primary"
          className="rounded-full"
          disabled={previewSectionIndex < 0 || previewSectionIndex >= RENTAL_APPLICATION_SECTIONS.length - 1}
          data-attr="application-preview-next"
          onClick={() => stepPreviewSection(1)}
        >
          Next ›
        </Button>
      </div>
    </div>
  );

  if (!open) return null;

  const currentSection = RENTAL_APPLICATION_SECTIONS.find((section) => section.id === stepId);

  return (
    <>
      <AddWorkspace
        title={title}
        steps={workspaceSteps}
        current={current}
        onJump={jump}
        onClose={onClose}
        onRequestClose={() => {
          if (addChooserSectionId) {
            setAddChooserSectionId(null);
            return false;
          }
          return true;
        }}
        dirty={dirty}
        discardTitle="Discard changes"
        discardBody="Discard unsaved changes to this application?"
        assistantContext="Edit application"
        assistantScopeKey="edit-application-workspace"
        sidePanel={
          <ApplicationSectionPreviewPane
            section={previewSection}
            fields={previewFields}
            applicationPreviewPropertyId={applicationPreviewPropertyId}
          />
        }
        lastLabel={templateEditorMode === "add" ? "Add application" : "Save"}
        lastDisabled={saving || (isTemplateEditor ? !templateLabel.trim() : !dirty) || hasFieldErrors}
        onBeforeNext={() => {
          if (stepId === "name" && !templateLabel.trim()) {
            setTemplateLabelError("Enter a name for this application.");
            return false;
          }
          return true;
        }}
        busy={saving}
        onFinish={() => void commitSave()}
        saveState={saving ? "Saving…" : dirty ? "Not saved yet" : "Saved"}
        dataAttrPrefix="application-questions"
        finishDataAttr="application-questions-save"
        footerNote={
          saveError ? (
            <span className="text-sm text-rose-600" role="alert" data-attr="application-questions-save-error">
              {saveError}
            </span>
          ) : isBulkSave ? (
            <span>Applies to {bulkIds.length} properties</span>
          ) : null
        }
        dangerAction={
          showDelete ? (
            <button
              type="button"
              className="min-h-[44px] rounded-full border border-red-200 bg-card px-6 text-[14px] font-bold text-red-700 disabled:opacity-45"
              data-attr="application-questions-delete"
              disabled={saving}
              onClick={() => void handleDelete()}
            >
              Delete
            </button>
          ) : null
        }
      >
        {stepId === "name" ? (
          <StepColumn>
            <StepHeading
              title="Name"
              action={
                <button type="button" className="text-xs font-semibold text-primary underline-offset-2 hover:underline" onClick={restoreDefaults}>
                  {restoreLabel}
                </button>
              }
            />
            <label className={WIZARD_LABEL_CLASS} htmlFor="application-template-name">
              Application name
            </label>
            <Input
              id="application-template-name"
              value={templateLabel}
              onChange={(e) => {
                setTemplateLabel(e.target.value);
                setTemplateLabelError(null);
                setDirty(true);
              }}
              placeholder="e.g. Summer intern application"
              data-attr="property-application-name"
            />
            {templateLabelError ? <p className="mt-1.5 text-sm text-rose-600">{templateLabelError}</p> : null}
          </StepColumn>
        ) : null}
        {stepId === "form" ? (
          <StepColumn>
            <StepHeading
              title="Form"
              action={
                <button type="button" className="text-xs font-semibold text-primary underline-offset-2 hover:underline" onClick={restoreDefaults}>
                  {restoreLabel}
                </button>
              }
            />
            <div className="flex gap-1 rounded-full border border-border bg-accent/30 p-1" role="tablist" aria-label="Application form">
              {APPLICATION_FORM_VARIANTS.map((v) => {
                const active = variant === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={v.hint}
                    data-attr={`application-variant-tab-${v.id}`}
                    onClick={() => {
                      setVariant(v.id);
                      setExpandedSectionIds(collapsedApplicationSections());
                      setExpandedQuestionIds(new Set());
                    }}
                    className={`flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                      active ? "bg-card text-foreground shadow-sm" : "text-muted hover:text-foreground"
                    }`}
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>
          </StepColumn>
        ) : null}
        {currentSection ? (
          <StepColumn>
            <StepHeading title={currentSection.title} action={sectionAddButton(currentSection.id)} />
            {renderSection(currentSection.id)}
          </StepColumn>
        ) : null}
        {stepId === "preview" ? (
          <StepColumn>
            <StepHeading title="Preview" />
            {previewBody}
          </StepColumn>
        ) : null}
      </AddWorkspace>
      <Modal
        open={Boolean(addChooserSectionId)}
        title="Add question"
        onClose={() => setAddChooserSectionId(null)}
        presentation="dialog"
        dense
        panelClassName="max-w-xl"
        stackClassName="fixed inset-0 z-[90] overflow-y-auto overscroll-contain"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="application-questions-add-confirm"
              onClick={confirmAddChoice}
            >
              {addChoice === "blank" ? "Add question" : "Add questions"}
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-3 transition has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary/30">
            <input
              type="radio"
              name="application-add-choice"
              className="mt-1 h-4 w-4 text-primary"
              checked={addChoice === "blank"}
              onChange={() => setAddChoice("blank")}
              data-attr="application-question-add-choice-blank"
            />
            <span>
              <span className="block text-sm font-semibold text-foreground">Blank question</span>
            </span>
          </label>
          <p className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Question packs</p>
          {APPLICATION_QUESTION_PACKS.map((pack) => (
            <label
              key={pack.id}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-3 transition has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary/30"
            >
              <input
                type="radio"
                name="application-add-choice"
                className="mt-1 h-4 w-4 text-primary"
                checked={addChoice === pack.id}
                onChange={() => setAddChoice(pack.id)}
                data-attr={`application-question-add-choice-${pack.id}`}
              />
              <span>
                <span className="block text-sm font-semibold text-foreground">
                  {pack.label}
                  {pack.recommended ? (
                    <span className="ml-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase text-primary">
                      Recommended
                    </span>
                  ) : null}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Modal>
    </>
  );
}
