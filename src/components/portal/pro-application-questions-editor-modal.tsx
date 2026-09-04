"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApplicationQuestionEditModal } from "@/components/portal/application-question-edit-modal";
import { Modal, ModalFooter, MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import {
  PortalCollapsibleEditRow,
  PORTAL_EDIT_ROW_ICON_BUTTON_CLASS,
} from "@/components/portal/portal-collapsible-edit-row";
import { PortalEditRow } from "@/components/portal/portal-edit-row";
import {
  CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS,
  normalizeCustomApplicationFields,
  type ManagerCustomApplicationFieldType,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  applicationConfigFieldsFromSubmission,
  persistApplicationConfigToPropertyIds,
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import {
  applicationConfigForVariant,
  customApplicationConfigWithAllStandardQuestions,
  mergeApplicationConfigForVariant,
  reenableListingApplicationField,
  removeListingApplicationField,
  resolveDisabledStandardApplicationFields,
  editorVisibleDisabledApplicationFields,
  resolveListingApplicationFields,
  restoreDefaultApplicationConfig,
  STANDARD_APPLICATION_FIELD_COUNT,
  type ApplicationConfigSlice,
  type ApplicationFormVariant,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";
import { RENTAL_APPLICATION_SECTIONS } from "@/lib/rental-application/application-sections";
import {
  createPropertyApplicationTemplate,
  syncLegacyApplicationFieldsFromTemplates,
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
  return CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS.find((o) => o.id === type)?.label ?? type;
}

export { typeLabel as applicationQuestionTypeLabel };

function questionSubtitle(field: ResolvedApplicationField): string {
  return `${field.isStandard ? "Built-in" : "Custom"} · ${typeLabel(field.type)}${field.required ? " · Required" : " · Optional"}`;
}

function persistApplicationConfig({
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
}): boolean {
  const bulkIds = propertyIds?.filter((id) => id.trim()) ?? [];
  if (bulkIds.length > 0) {
    const { saved, failed } = persistApplicationConfigToPropertyIds(
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
  if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
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

/** Shared application-question editor — property templates and bulk Applications edit. */
export function ManagerApplicationQuestionsEditorModal({
  open,
  title = "Application",
  sub,
  saveTarget,
  propertyIds,
  managerUserId,
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
  ) => boolean;
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
  const [editOpen, setEditOpen] = useState(false);
  const childClosingRef = useRef(false);
  const [editingField, setEditingField] = useState<ResolvedApplicationField | null>(null);
  const [isNewField, setIsNewField] = useState(false);
  const [newFieldSectionId, setNewFieldSectionId] = useState("additional");
  // Round 31: every edit stays local until an explicit Save. `dirty` gates the Save button
  // and drives the discard confirmation so a stray click can never overwrite properties.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const baseSub = templateEditorMode === "add" ? submissionForNewCustomApplication(sub) : sub;
    setLocalSub(baseSub);
    setVariant(templateEditorMode === "add" ? "standard" : initialVariant);
    setTemplateLabel(applicationTemplate?.label ?? "");
    setTemplateLabelError(null);
    setExpandedSectionIds(collapsedApplicationSections());
    setEditOpen(false);
    setEditingField(null);
    setIsNewField(false);
    setDirty(templateEditorMode === "add");
    setSaving(false);
  }, [open, sub, initialVariant, templateEditorMode, applicationTemplate]);

  const bulkIds = propertyIds?.filter((id) => id.trim()) ?? [];
  const isBulkSave = bulkIds.length > 0;
  const showDelete = templateEditorMode === "edit" && canDelete && Boolean(onDelete);

  const handleDelete = () => {
    if (!showDelete || !onDelete) return;
    if (!window.confirm("Delete this application? This cannot be undone.")) return;
    onDelete();
  };

  // The config slice for the form the manager is editing.
  // top-level triplet; short-term reads its own, defaulting to PropLane's
  // curated short-term question set until edited. Edits to one never touch the
  // other.
  const configSlice = useMemo(() => applicationConfigForVariant(localSub, variant), [localSub, variant]);

  const applicationFields = useMemo(
    () => resolveListingApplicationFields(configSlice, normalizeCustomApplicationFields),
    [configSlice],
  );
  const disabledFields = useMemo(
    () => editorVisibleDisabledApplicationFields(variant, configSlice),
    [configSlice, variant],
  );

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

  const commitSave = () => {
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
      const ok = window.confirm(
        `Apply these application settings to ${bulkIds.length} properties? Existing per-property differences will be replaced.`,
      );
      if (!ok) return;
    }
    setSaving(true);

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
      const merged = withPropertyApplicationTemplatesExplicit(localSub, nextTemplates);
      if (
        !onPersistSubmission(merged, {
          message: templateEditorMode === "add" ? "Application added." : "Application saved.",
        })
      ) {
        setSaving(false);
        return;
      }
      setSaving(false);
      setDirty(false);
      onSaved();
      onClose();
      return;
    }

    const okSaved = persistApplicationConfig({
      next: localSub,
      saveTarget,
      propertyIds: isBulkSave ? bulkIds : undefined,
      managerUserId,
      showToast,
      singleSuccessMessage: "Application settings saved.",
    });
    setSaving(false);
    if (!okSaved) return;
    setDirty(false);
    onSaved();
    onClose();
  };

  const requestClose = () => {
    if (dirty && !window.confirm("Discard unsaved changes to this application?")) return;
    onClose();
  };

  const openEdit = (field: ResolvedApplicationField) => {
    setEditingField(field);
    setIsNewField(false);
    setEditOpen(true);
  };

  const openAdd = (sectionId: string) => {
    setEditingField(null);
    setIsNewField(true);
    setNewFieldSectionId(sectionId);
    setEditOpen(true);
    setExpandedSectionIds((prev) => new Set(prev).add(sectionId));
  };

  const closeEdit = () => {
    childClosingRef.current = true;
    setEditOpen(false);
    setEditingField(null);
    setIsNewField(false);
    queueMicrotask(() => {
      childClosingRef.current = false;
    });
  };

  const handleParentClose = () => {
    if (childClosingRef.current) return;
    if (editOpen) {
      closeEdit();
      return;
    }
    requestClose();
  };

  const removeField = (field: ResolvedApplicationField) => {
    applyEditedSlice(removeListingApplicationField(configSlice, field));
  };

  const reenableField = (field: ResolvedApplicationField) => {
    if (!field.standardKey) return;
    applyEditedSlice(reenableListingApplicationField(configSlice, field.standardKey));
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

  const onQuestionSaved = (next: ManagerListingSubmissionV1) => {
    setLocalSub(next);
    setDirty(true);
  };

  const sectionAddButton = (sectionId: string) => (
    <button
      type="button"
      className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
      title="Add question"
      aria-label="Add question"
      data-attr="application-questions-add"
      onClick={() => openAdd(sectionId)}
    >
      <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden />
    </button>
  );

  return (
    <Modal
      open={open}
      title={title}
      onClose={handleParentClose}
      dismissBlocked={editOpen}
      description={
          isTemplateEditor
            ? "Name your application, then adjust questions below. Every custom application includes all standard questions."
            : "Expand a section to see its questions. Tap a question to edit; use × to remove."
        }
        presentation="dialog"
        dense
        panelClassName="flex max-h-[min(90vh,56rem)] w-full max-w-4xl flex-col"
        footer={
          <ModalFooter className="w-full">
            {showDelete ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-red-200 text-red-700 hover:bg-red-50"
                data-attr="application-questions-delete"
                disabled={saving}
                onClick={handleDelete}
              >
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              variant="primary"
              className="ml-auto rounded-full"
              data-attr="application-questions-save"
              disabled={saving || (isTemplateEditor ? !templateLabel.trim() : !dirty)}
              onClick={commitSave}
            >
              {saving ? "Saving…" : templateEditorMode === "add" ? "Add application" : "Save"}
            </Button>
          </ModalFooter>
        }
      >
        {isBulkSave ? (
          <p className="mb-4 text-sm text-muted">
            These settings apply to all {bulkIds.length} selected properties. Existing per-property differences are
            replaced when you save changes.
          </p>
        ) : null}
        <div className="space-y-3">
          {isTemplateEditor ? (
            <div>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="application-template-name">
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
            </div>
          ) : null}
          {lockVariant || isTemplateEditor ? null : (
          <div
            className="flex gap-1 rounded-full border border-border bg-accent/30 p-1"
            role="tablist"
            aria-label="Application form"
          >
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
                  }}
                  className={`flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
          )}

          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-sm text-muted">
              {applicationFields.length} question{applicationFields.length === 1 ? "" : "s"}
              {isTemplateEditor &&
              (templateEditorMode === "add" ||
                (applicationTemplate != null && !applicationTemplate.listingSeedKey))
                ? ` · includes all ${STANDARD_APPLICATION_FIELD_COUNT} standard questions`
                : !isTemplateEditor
                  ? ` on the ${variant === "short_term" ? "short-term" : "long-term"} application`
                  : ""}
            </p>
            <button
              type="button"
              className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
              onClick={restoreDefaults}
            >
              {isTemplateEditor &&
              (templateEditorMode === "add" ||
                (applicationTemplate != null && !applicationTemplate.listingSeedKey))
                ? "Reset all standard questions"
                : "Restore PropLane defaults"}
            </button>
          </div>

          {RENTAL_APPLICATION_SECTIONS.map((section) => {
            const sectionQuestions = applicationFields.filter((f) => (f.section ?? "additional") === section.id);
            const sectionDisabled = disabledFields.filter((f) => (f.section ?? "additional") === section.id);
            const sectionExpanded = expandedSectionIds.has(section.id);
            const sectionHasContent = sectionQuestions.length > 0 || sectionDisabled.length > 0;
            return (
              <PortalCollapsibleEditRow
                key={section.id}
                title={section.title}
                titleVariant="label"
                subtitle={
                  sectionQuestions.length === 0
                    ? sectionDisabled.length > 0
                      ? `${sectionDisabled.length} question${sectionDisabled.length === 1 ? "" : "s"} off`
                      : "No questions in this section"
                    : `${sectionQuestions.length} question${sectionQuestions.length === 1 ? "" : "s"}${
                        sectionDisabled.length > 0 ? ` · ${sectionDisabled.length} off` : ""
                      }`
                }
                expanded={sectionExpanded}
                collapsible={sectionHasContent}
                onExpandedChange={(next) => {
                  setExpandedSectionIds((prev) => {
                    const ids = new Set(prev);
                    if (next) ids.add(section.id);
                    else ids.delete(section.id);
                    return ids;
                  });
                }}
                toggleDataAttr={`application-section-toggle-${section.id}`}
                contentClassName="space-y-2 pt-1"
                headerActions={sectionAddButton(section.id)}
              >
                {sectionQuestions.length === 0 && sectionDisabled.length === 0 ? (
                  <p className="text-sm text-muted">No questions in this section yet.</p>
                ) : (
                  <div className="space-y-2">
                    {sectionQuestions.map((field) => (
                      <PortalEditRow
                        key={field.id}
                        title={field.label.trim() || "Untitled question"}
                        subtitle={questionSubtitle(field)}
                        titleVariant="semibold"
                        className="border-0 bg-accent/15 shadow-none"
                        clickDataAttr={`application-question-edit-${field.id}`}
                        onClick={() => openEdit(field)}
                        onRemove={() => removeField(field)}
                        removeIconOnly
                        removeTitle="Remove question"
                        removeDataAttr="application-question-remove"
                      />
                    ))}
                    {sectionDisabled.map((field) => (
                      <div
                        key={field.id}
                        className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-border bg-accent/20 px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-muted line-through">
                            {field.label.trim() || "Untitled question"}
                          </p>
                          <p className="text-xs text-muted/80">Off · not asked on this application</p>
                        </div>
                        <button
                          type="button"
                          className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
                          title="Add question back"
                          aria-label="Add question back"
                          data-attr="application-question-reenable"
                          onClick={() => reenableField(field)}
                        >
                          <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </PortalCollapsibleEditRow>
            );
          })}
        </div>

      <ApplicationQuestionEditModal
        open={editOpen}
        field={editingField}
        isNew={isNewField}
        sectionId={newFieldSectionId}
        sub={localSub}
        variant={variant}
        saveTarget={saveTarget}
        propertyIds={isBulkSave ? bulkIds : undefined}
        managerUserId={managerUserId}
        onClose={closeEdit}
        onSaved={onQuestionSaved}
        showToast={showToast}
        deferPersist
      />
    </Modal>
  );
}
