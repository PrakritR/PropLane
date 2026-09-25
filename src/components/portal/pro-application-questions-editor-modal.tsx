"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ApplicationFormBuilder, ApplicationSectionPreviewPane } from "@/components/portal/application-form-builder";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import { CosignerApplyFlow } from "@/app/(public)/rent/apply/cosigner-flow";
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
  customApplicationConfigWithAllStandardQuestions,
  mergeApplicationConfigForVariant,
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
  applicationDraftReviewFingerprint,
  applicationFormVariantForTemplate,
  applicationTemplateQuestionPublishGate,
  applicationTemplateQuestionConfigFromSlice,
  createPropertyApplicationTemplate,
  draftQuestionConfigForTemplate,
  withPropertyApplicationTemplatesExplicit,
  updatePropertyApplicationTemplate,
  type ApplicationTemplateQuestionConfig,
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
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [originalPdfPath, setOriginalPdfPath] = useState<string | null>(null);
  const [importedQuestionDraft, setImportedQuestionDraft] = useState<ApplicationTemplateQuestionConfig | null>(null);
  const [importIssues, setImportIssues] = useState<Array<{ pageNumber: number | null; code: string; message: string }>>([]);
  const [resolvedImportIssueIndexes, setResolvedImportIssueIndexes] = useState<number[]>([]);
  const [compareView, setCompareView] = useState<"original" | "form">("form");
  const [reviewingSource, setReviewingSource] = useState(false);
  const [questionDisplayOrder, setQuestionDisplayOrder] = useState<string[]>([]);
  const initializedEditorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      initializedEditorRef.current = null;
      return;
    }
    const editorKey = `${applicationPreviewPropertyId ?? "portfolio"}:${templateEditorMode ?? "listing"}:${applicationTemplate?.id ?? "new"}:${initialVariant}`;
    if (initializedEditorRef.current === editorKey) return;
    initializedEditorRef.current = editorKey;
    const templateDraft = applicationTemplate ? draftQuestionConfigForTemplate(applicationTemplate) : null;
    const baseSub = templateEditorMode === "add"
      ? submissionForNewCustomApplication(sub)
      : templateDraft
        ? { ...sub, ...mergeApplicationConfigForVariant(applicationFormVariantForTemplate(applicationTemplate!), templateDraft) }
        : sub;
    setQuestionDisplayOrder(
      templateDraft?.questionDisplayOrder?.slice() ??
      applicationConfigForVariant(baseSub, initialVariant).questionDisplayOrder ??
      [],
    );
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
    setOriginalPdfPath(applicationTemplate?.draftQuestionConfig?.importProvenance?.sourcePath ?? null);
    setImportedQuestionDraft(applicationTemplate?.draftQuestionConfig?.importProvenance ? applicationTemplate.draftQuestionConfig : null);
    setImportIssues(applicationTemplate?.draftQuestionConfig?.importProvenance?.issues ?? []);
    setResolvedImportIssueIndexes(applicationTemplate?.draftQuestionConfig?.importProvenance?.resolvedIssueIndexes ?? []);
    setCompareView("form");
  }, [open, sub, initialVariant, templateEditorMode, applicationTemplate, applicationPreviewPropertyId]);

  const bulkIds = propertyIds?.filter((id) => id.trim()) ?? [];
  const isBulkSave = bulkIds.length > 0;
  const showDelete = templateEditorMode === "edit" && canDelete && Boolean(onDelete);
  const confirm = useConfirm();

  const canEditBuiltIn = (field: ResolvedApplicationField, action: "label" | "required" | "visibility" | "order"): boolean => {
    if (!field.isStandard) return true;
    const key = field.standardKey ?? "";
    if (variant === "cosigner") {
      if (action === "order") return false;
      if (key === "personal-date-of-birth" || key === "personal-social-security-number") return true;
      return action === "label" && (key === "personal-full-legal-name" || key === "personal-phone" || key === "personal-email");
    }
    if (action === "order" && (field.section === "household" || field.section === "property")) return false;
    if (action === "label" && field.section === "household") return false;
    if (action !== "order" && (key === "personal-full-legal-name" || key === "personal-phone" || key === "personal-email")) {
      return action === "label";
    }
    return true;
  };

  const handleDelete = async () => {
    if (!showDelete || !onDelete) return;
    if (!(await confirm({ description: "Delete this application?" }))) return;
    onDelete();
  };

  // The config slice for the form the manager is editing.
  // top-level triplet; short-term reads its own, defaulting to PropLane's
  // curated short-term question set until edited. Edits to one never touch the
  // other.
  const configSlice = useMemo(() => ({
    ...applicationConfigForVariant(localSub, variant),
    questionDisplayOrder,
  }), [localSub, questionDisplayOrder, variant]);

  // `normalizeCustomApplicationFieldsForEditor` (not the plain normalizer) keeps
  // an in-progress row with an empty label or no options yet — it must stay
  // visible IN PLACE while the manager is still filling it in, not vanish on
  // every re-render before Save.
  const applicationFields = useMemo(
    () => {
      const configured = resolveListingApplicationFields(configSlice, normalizeCustomApplicationFieldsForEditor);
      const structural = resolveListingApplicationFields(
        { ...configSlice, questionDisplayOrder: undefined },
        normalizeCustomApplicationFieldsForEditor,
      );
      const configuredPosition = new Map(configured.map((field, index) => [field.id, index]));
      const structuralPosition = new Map(structural.map((field, index) => [field.id, index]));
      return structural.toSorted((left, right) => {
        const section = left.section ?? "additional";
        if (section !== (right.section ?? "additional")) {
          return (structuralPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (structuralPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER);
        }
        const customQuestionsStayAfterBuiltIns = section === "household" || section === "property" || section === "review";
        if (customQuestionsStayAfterBuiltIns && left.isStandard !== right.isStandard) return left.isStandard ? -1 : 1;
        return (configuredPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (configuredPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      });
    },
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
    if (nextSlice.questionDisplayOrder) setQuestionDisplayOrder(nextSlice.questionDisplayOrder);
    setLocalSub((prev) => ({ ...prev, ...mergeApplicationConfigForVariant(variant, nextSlice) }));
    setImportedQuestionDraft((previous) =>
      previous?.importProvenance && (previous.importProvenance.unresolvedCount ?? 0) === 0
        ? { ...previous, importProvenance: { ...previous.importProvenance, unresolvedCount: 1 } }
        : previous,
    );
    setResolvedImportIssueIndexes([]);
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

  const commitSave = async ({ publish = false }: { publish?: boolean } = {}) => {
    if (publish && isBulkSave) {
      setSaveError("Publish each property's application separately.");
      return;
    }
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
          {
            ...createPropertyApplicationTemplate({ kind: "long-term", label: trimmed }),
            draftQuestionConfig: {
              ...applicationTemplateQuestionConfigFromSlice(applicationConfigForVariant(sanitizedSub, "standard")),
              questionDisplayOrder: applicationFields.map((field) => field.id),
            },
          },
        ];
      } else {
        const templateVariant = applicationFormVariantForTemplate(applicationTemplate!);
        nextTemplates = updatePropertyApplicationTemplate(templates, applicationTemplate!.id, {
          label: trimmed,
          draftQuestionConfig: {
            ...applicationTemplateQuestionConfigFromSlice(
              applicationConfigForVariant(sanitizedSub, templateVariant),
              importedQuestionDraft ?? draftQuestionConfigForTemplate(applicationTemplate!),
            ),
            questionDisplayOrder: configSlice.questionDisplayOrder,
          },
        });
      }
      // Template edits must not mutate the listing-wide legacy triplet. That
      // triplet remains the fallback for templates created before versioning.
      let publishTarget: PropertyApplicationTemplate | null = null;
      if (publish) {
        const target = nextTemplates.find((template) =>
          template.id === applicationTemplate?.id || (templateEditorMode === "add" && template.label === trimmed),
        );
        if (!target) {
          setSaving(false);
          setSaveError("Could not prepare this application for publishing.");
          return;
        }
        const gate = applicationTemplateQuestionPublishGate(target);
        if (!gate.ok) {
          setSaving(false);
          setSaveError(gate.reason);
          return;
        }
        publishTarget = target;
      }
      const merged = withPropertyApplicationTemplatesExplicit(sub, nextTemplates);
      const okSaved = await onPersistSubmission(merged, {
        message: publish ? "Application draft saved." : templateEditorMode === "add" ? "Application added." : "Application saved.",
      });
      if (!okSaved) {
        setSaving(false);
        setSaveError("Could not save. Your changes are still here — try again.");
        return;
      }
      if (publish && publishTarget && applicationPreviewPropertyId) {
        const response = await fetch("/api/portal/application-template-import", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            propertyId: applicationPreviewPropertyId,
            templateId: publishTarget.id,
            expectedPublishedVersion: applicationTemplate?.publishedQuestionConfig?.version ?? 0,
          }),
        });
        const result = await response.json().catch(() => null) as { error?: string; template?: PropertyApplicationTemplate } | null;
        if (!response.ok || !result?.template) {
          setSaving(false);
          setDirty(false);
          setSaveError(result?.error || "The draft was saved, but it could not be published. Try again.");
          return;
        }
      }
      setSaving(false);
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

  const importPdf = async (file: File) => {
    if (!applicationTemplate || !applicationPreviewPropertyId || isBulkSave) return;
    setImporting(true);
    try {
      const body = new FormData();
      body.set("propertyId", applicationPreviewPropertyId);
      body.set("templateId", applicationTemplate.id);
      body.set("file", file);
      const response = await fetch("/api/portal/application-template-import", { method: "POST", body });
      const result = await response.json().catch(() => null) as { error?: string; draft?: ApplicationTemplateQuestionConfig; source?: { path?: string }; issues?: Array<{ pageNumber: number | null; code: string; message: string }> } | null;
      if (!response.ok || !result) throw new Error(result?.error || "Could not import the application PDF.");
      setOriginalPdfPath(result.source?.path ?? null);
      setImportIssues(result.issues ?? []);
      setResolvedImportIssueIndexes([]);
      if (result.draft) {
        setImportedQuestionDraft(result.draft);
        setQuestionDisplayOrder(result.draft.questionDisplayOrder ?? []);
        setLocalSub((previous) => ({
          ...previous,
          ...mergeApplicationConfigForVariant(applicationFormVariantForTemplate(applicationTemplate), result.draft!),
        }));
        setDirty(true);
      }
      showToast(result.issues?.length ? "Imported as a draft. Resolve the flagged source issues before publishing." : "Imported application draft saved.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not import the application PDF.");
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const reviewImportedSource = async () => {
    if (!applicationTemplate || !applicationPreviewPropertyId || !templates || !onPersistSubmission || isBulkSave) return;
    const currentDraft = importedQuestionDraft ?? draftQuestionConfigForTemplate(applicationTemplate);
    const sourceSha256 = currentDraft?.importProvenance?.sourceSha256;
    if (!currentDraft?.importProvenance?.sourcePath || !sourceSha256) {
      setSaveError("The imported source is unavailable. Import it again before comparing.");
      return;
    }
    if (importIssues.some((issue) => issue.code === "unreadable_page")) {
      setSaveError("Some PDF pages could not be read. Upload a clearer PDF before publishing.");
      return;
    }
    if (resolvedImportIssueIndexes.length !== importIssues.length) {
      setSaveError("Resolve each listed PDF issue before confirming the application.");
      return;
    }
    setReviewingSource(true);
    setSaveError(null);
    const draftQuestionConfig = applicationTemplateQuestionConfigFromSlice(configSlice, currentDraft);
    const nextTemplates = updatePropertyApplicationTemplate(templates, applicationTemplate.id, { draftQuestionConfig });
    const saved = await onPersistSubmission(withPropertyApplicationTemplatesExplicit(sub, nextTemplates), {
      message: "Application draft saved.",
    });
    if (!saved) {
      setReviewingSource(false);
      setSaveError("Could not save the draft before source review. Try again.");
      return;
    }
    const draftFingerprint = applicationDraftReviewFingerprint(draftQuestionConfig);
    const metaResponse = await fetch(`/api/portal/application-template-import?propertyId=${encodeURIComponent(applicationPreviewPropertyId)}&templateId=${encodeURIComponent(applicationTemplate.id)}&meta=1`, { cache: "no-store" });
    const meta = await metaResponse.json().catch(() => null) as { draftFingerprint?: string; revision?: string } | null;
    if (!metaResponse.ok || !meta?.revision || meta.draftFingerprint !== draftFingerprint) {
      setReviewingSource(false);
      setSaveError("The application draft changed. Compare it again before publishing.");
      return;
    }
    const response = await fetch("/api/portal/application-template-import", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ propertyId: applicationPreviewPropertyId, templateId: applicationTemplate.id, sourceSha256, draftFingerprint, expectedRevision: meta.revision, resolvedIssueIndexes: resolvedImportIssueIndexes }),
    });
    const result = await response.json().catch(() => null) as {
      error?: string;
      draft?: ApplicationTemplateQuestionConfig;
    } | null;
    setReviewingSource(false);
    if (!response.ok || !result?.draft) {
      setSaveError(result?.error || "Could not confirm the source comparison. Compare again before publishing.");
      return;
    }
    const reviewedTemplates = updatePropertyApplicationTemplate(nextTemplates, applicationTemplate.id, {
      draftQuestionConfig: result.draft,
    });
    const reviewedSubmission = withPropertyApplicationTemplatesExplicit(sub, reviewedTemplates);
    setLocalSub({ ...reviewedSubmission, ...mergeApplicationConfigForVariant(variant, result.draft) });
    setQuestionDisplayOrder(result.draft.questionDisplayOrder ?? []);
    setImportedQuestionDraft(result.draft);
    setImportIssues(result.draft.importProvenance?.issues ?? []);
    setDirty(false);
    showToast("Imported PDF comparison confirmed.");
  };

  const jump = (index: number) => {
    setStepIdx(index);
    const id = workspaceSteps[index]?.id;
    if (id && RENTAL_APPLICATION_SECTIONS.some((section) => section.id === id)) {
      setPreviewSectionPick(id as RentalApplicationSectionId);
    }
  };

  const removeField = (field: ResolvedApplicationField) => {
    if (!canEditBuiltIn(field, "visibility")) return;
    applyEditedSlice(removeListingApplicationField(configSlice, field));
  };

  const reenableField = (field: ResolvedApplicationField) => {
    if (!field.standardKey || !canEditBuiltIn(field, "visibility")) return;
    applyEditedSlice(reenableListingApplicationField(configSlice, field.standardKey));
  };

  const patchField = (field: ResolvedApplicationField, patch: Partial<ManagerCustomApplicationField>) => {
    if ((patch.label !== undefined && !canEditBuiltIn(field, "label")) ||
      (patch.required !== undefined && !canEditBuiltIn(field, "required")) ||
      (patch.options !== undefined && field.isStandard && field.options.length > 0) ||
      (patch.type !== undefined && variant === "cosigner" && !field.isStandard && (patch.type === "file" || patch.type === "photos"))) return;
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
    if (!canEditBuiltIn(field, "order")) return false;
    const index = applicationFields.findIndex((candidate) => candidate.id === field.id);
    const neighbor = applicationFields[index + (direction === "up" ? -1 : 1)];
    if (!neighbor || (neighbor.section ?? "additional") !== (field.section ?? "additional")) return false;
    const section = field.section ?? "additional";
    const customQuestionsStayAfterBuiltIns = section === "household" || section === "property" || section === "review";
    if (customQuestionsStayAfterBuiltIns && field.isStandard !== neighbor.isStandard) return false;
    if (!canEditBuiltIn(neighbor, "order")) return false;
    return true;
  };

  const moveField = (field: ResolvedApplicationField, direction: "up" | "down"): void => {
    if (!canMoveField(field, direction)) return;
    const index = applicationFields.findIndex((candidate) => candidate.id === field.id);
    const neighbor = applicationFields[index + (direction === "up" ? -1 : 1)];
    if (!neighbor || (neighbor.section ?? "additional") !== (field.section ?? "additional")) return;
    const orderedIds = applicationFields.map((candidate) => candidate.id);
    const nextIndex = index + (direction === "up" ? -1 : 1);
    [orderedIds[index], orderedIds[nextIndex]] = [orderedIds[nextIndex], orderedIds[index]];
    applyEditedSlice({ ...configSlice, questionDisplayOrder: orderedIds });
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
            canEditBuiltIn={canEditBuiltIn}
            blockedCustomTypes={variant === "cosigner" ? ["file", "photos"] : []}
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
            {originalPdfPath && applicationTemplate && applicationPreviewPropertyId ? (
              <div className="space-y-2" data-attr="application-import-compare">
                <div className="flex gap-1 rounded-full border border-border bg-accent/30 p-1 md:hidden" role="group" aria-label="Imported application comparison">
                  {(["original", "form"] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      aria-pressed={compareView === view}
                      onClick={() => setCompareView(view)}
                      className={`min-h-11 flex-1 rounded-full px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${compareView === view ? "bg-card text-foreground" : "text-muted"}`}
                    >
                      {view === "original" ? "Original" : "Form"}
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <iframe
                    title="Original imported application PDF"
                    className={`h-[34rem] w-full rounded-xl border border-border ${compareView === "original" ? "block" : "hidden md:block"}`}
                    src={`/api/portal/application-template-import?propertyId=${encodeURIComponent(applicationPreviewPropertyId)}&templateId=${encodeURIComponent(applicationTemplate.id)}&path=${encodeURIComponent(originalPdfPath)}`}
                  />
                  <div className={`${compareView === "form" ? "block" : "hidden md:block"} h-[34rem] overflow-y-auto rounded-xl border border-border bg-card p-3`}>
                    {variant === "cosigner" ? <CosignerApplyFlow
                      onBack={() => {}}
                      previewMode
                      embedded
                      showToast={showToast}
                      applicationKind={applicationTemplate?.kind === "short-term" ? "short-term" : "long-term"}
                      previewConfig={configSlice}
                    /> : <RentalApplicationWizard
                      showToast={showToast}
                      mode="manager"
                      layout="embedded"
                      linkedPropertyId={applicationPreviewPropertyId}
                      linkedRentalType={variant === "short_term" ? "short_term" : "standard"}
                      templatePreviewVariant={variant}
                      templatePreview
                      templatePreviewSubmission={{
                        ...localSub,
                        ...mergeApplicationConfigForVariant(variant, configSlice),
                      }}
                    />}
                  </div>
                </div>
              </div>
            ) : null}
            {applicationPreviewPropertyId && !originalPdfPath ? (
              <div className="rounded-2xl border border-border bg-card p-3" data-attr="application-full-wizard-preview">
                {variant === "cosigner" ? <CosignerApplyFlow
                  onBack={() => {}}
                  previewMode
                  embedded
                  showToast={showToast}
                  applicationKind={applicationTemplate?.kind === "short-term" ? "short-term" : "long-term"}
                  previewConfig={configSlice}
                /> : <RentalApplicationWizard
                  showToast={showToast}
                  mode="manager"
                  layout="embedded"
                  linkedPropertyId={applicationPreviewPropertyId}
                  linkedRentalType={variant === "short_term" ? "short_term" : "standard"}
                  templatePreviewVariant={variant}
                  templatePreview
                  templatePreviewSubmission={{
                    ...localSub,
                    ...mergeApplicationConfigForVariant(variant, configSlice),
                  }}
                />}
              </div>
            ) : null}
            {isTemplateEditor && applicationTemplate && applicationPreviewPropertyId && !isBulkSave ? (
              <div className="flex flex-wrap gap-2">
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/pdf"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importPdf(file);
                  }}
                />
                <Button type="button" variant="outline" className="rounded-full" disabled={importing} onClick={() => importInputRef.current?.click()}>
                  {importing ? "Importing…" : "Import PDF"}
                </Button>
                {originalPdfPath ? (
                  <a
                    className="inline-flex min-h-[44px] items-center rounded-full border border-border px-4 text-sm font-semibold"
                    href={`/api/portal/application-template-import?propertyId=${encodeURIComponent(applicationPreviewPropertyId)}&templateId=${encodeURIComponent(applicationTemplate.id)}&path=${encodeURIComponent(originalPdfPath)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Original PDF
                  </a>
                ) : null}
                {(importedQuestionDraft ?? applicationTemplate?.draftQuestionConfig)?.importProvenance?.sourceSha256 ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    disabled={reviewingSource || importing || saving}
                    onClick={() => void reviewImportedSource()}
                    data-attr="application-import-source-review"
                  >
                    {reviewingSource ? "Saving comparison…" : "Compare and confirm PDF"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {importIssues.length > 0 ? (
              <ul className="space-y-1 text-sm text-amber-800" data-attr="application-import-issues">
                {importIssues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.pageNumber ?? "document"}-${index}`}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        disabled={issue.code === "unreadable_page"}
                        checked={resolvedImportIssueIndexes.includes(index)}
                        onChange={(event) => setResolvedImportIssueIndexes((previous) =>
                          event.target.checked ? [...previous, index] : previous.filter((item) => item !== index)
                        )}
                        aria-label={`Resolved PDF issue ${index + 1}`}
                      />
                      <span>{issue.pageNumber ? `Page ${issue.pageNumber}: ` : "Document: "}{issue.message}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
            {isTemplateEditor && !isBulkSave ? (
              <Button
                type="button"
                variant="primary"
                className="rounded-full"
                disabled={saving || hasFieldErrors || !templateLabel.trim()}
                data-attr="application-questions-publish"
                onClick={() => void commitSave({ publish: true })}
              >
                Publish application
              </Button>
            ) : null}
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
