"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, Star } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  FloatingLabelField,
  MoneyInput,
  PanelSection,
  StepColumn,
  StepHeading,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ImportFileStrip } from "@/components/portal/listing-wizard-v2/import-upload-step";
import { ApplicationFormBuilder, ApplicationSectionPreviewPane } from "@/components/portal/application-form-builder";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";
import { CosignerApplyFlow } from "@/app/(public)/rent/apply/cosigner-flow";
import { sanitizeCustomApplicationFieldsForSave, validateField } from "@/components/portal/application-question-edit-modal";
import {
  PORTAL_EDIT_ROW_ICON_BUTTON_CLASS,
  PortalCollapsibleEditRow,
} from "@/components/portal/portal-collapsible-edit-row";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  PropertyFormStartFromFact,
  PropertyFormStartFromSelect,
  PropertyFormWizardCard,
  PropertyFormWizardRow,
  type PropertyFormStartFrom,
} from "@/components/portal/property-form-wizard-kit";
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
  NEVER_DISABLED_STANDARD_KEY_SET,
  type ApplicationConfigSlice,
  type ApplicationFormVariant,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";
import { RENTAL_APPLICATION_SECTIONS, type RentalApplicationSectionId } from "@/lib/rental-application/application-sections";
import { changedSectionEntries, diffImportSections } from "@/lib/import-staging/section-diff";
import { applicationFieldsToImportSections } from "@/lib/import-staging/application-sections";
import {
  APPLICATION_QUESTION_PACKS,
  buildQuestionsFromPack,
} from "@/lib/rental-application/application-question-packs";
import { useConfirm } from "@/components/providers/app-ui-provider";
import {
  isCosignerApplicationTemplate,
  leaseIdForApplication,
  mappableLeaseTemplates,
  mappingTargetError,
  setMappingTarget,
  type MappingSigningOrder,
} from "@/lib/application-lease-mapping";
import {
  applicationDraftReviewFingerprint,
  applicationFormVariantForTemplate,
  applicationTemplateQuestionPublishGate,
  applicationTemplateQuestionConfigFromSlice,
  createPropertyApplicationTemplate,
  draftQuestionConfigForTemplate,
  makePropertyApplicationTemplateId,
  withPropertyApplicationTemplatesExplicit,
  updatePropertyApplicationTemplate,
  readPropertyApplicationTemplates,
  type ApplicationTemplateQuestionConfig,
  type ApplicationTourOrder,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  APPLICATION_TOUR_ORDER_OPTIONS,
  normalizeApplicationTourOrder,
} from "@/lib/application-before-tour-policy";
import { PropertyFormUsedForMapping } from "@/components/portal/property-form-used-for-mapping";
import { PropertyFormFeeForCurrentForm } from "@/components/portal/property-form-resolved-fee";
import { usePropertyFormSetupSettings } from "@/lib/property-form-setup-settings.client";
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";
import {
  readPropertyLeaseTemplates,
  syncLegacyLeaseFieldsFromTemplates,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import {
  applyEffectiveApplicationForm,
  emptyWorkspaceApplicationFormTemplate,
  workspaceApplicationFormIsConfigured,
  type WorkspaceApplicationFormTemplate,
} from "@/lib/rental-application/workspace-application-form";

/** Question sections start collapsed; managers expand the ones they need. */
/** Select value standing for "no link" (a select option cannot carry null). */
const NO_LINK = "__none__";

function collapsedApplicationSections(): Set<string> {
  return new Set();
}

const APPLICATION_FORM_VARIANTS: ReadonlyArray<{ id: ApplicationFormVariant; label: string; hint: string }> = [
  { id: "standard", label: "Long-term", hint: "The full application for standard leases." },
  {
    id: "short_term",
    label: "Short-term",
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
    // A brand-new named application is always freshly authored content, so
    // it must stay fully editable regardless of whether this listing
    // otherwise follows the workspace form — never open ADD read-only.
    // (`applicationFormSource` is the listing-wide flag; the "Workspace
    // form" / "Custom for this listing" picker still lets the manager
    // switch it back once the template exists.)
    applicationFormSource: "custom",
  };
}

/** The pack offered pre-selected in the ADD flow. */
const RECOMMENDED_QUESTION_PACK = APPLICATION_QUESTION_PACKS.find((p) => p.recommended) ?? null;

/** Shared application-question editor — one full-page workspace, property templates and bulk Applications edit. */
/**
 * F001: another application already saved on this property under the same
 * (trimmed, case-insensitive) name. Pure, so it needs no memo.
 */
function duplicateApplicationNameError(
  label: string,
  templates: PropertyApplicationTemplate[] | undefined,
  currentTemplateId: string | undefined,
): string | null {
  if (!templates) return null;
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) return null;
  const clashes = templates.some(
    (candidate) => candidate.id !== currentTemplateId && candidate.label.trim().toLowerCase() === trimmed,
  );
  return clashes ? `An application named "${label.trim()}" already exists on this property.` : null;
}

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
  signingOrder,
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
  /**
   * The workspace signing order (Settings -> Applications & leases). Application first puts a
   * "Lease" row on the first step (one application, one lease). Absent
   * (not loaded yet) = no mapping row.
   */
  signingOrder?: MappingSigningOrder;
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
  // P003: this application's OWN fee/promo — null = "use the account
  // default". Local, dirty-tracked state saved through the normal
  // commitSave/Save flow (unlike the account-level `formSetup.patch`, which
  // saves immediately) — a fee override is part of the template record.
  const [feeOverrideEnabled, setFeeOverrideEnabled] = useState(false);
  const [feeOverrideCents, setFeeOverrideCents] = useState<number>(0);
  const [waiverOverrideEnabled, setWaiverOverrideEnabled] = useState(false);
  const [waiverOverrideCode, setWaiverOverrideCode] = useState("");
  const [expandedSectionIds, setExpandedSectionIds] = useState<Set<string>>(() => new Set());
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<Set<string>>(() => new Set());
  // The ADD flow's template chooser — which section it targets, or null when closed.
  const [addChooserSectionId, setAddChooserSectionId] = useState<string | null>(null);
  const [addChoice, setAddChoice] = useState<string>(RECOMMENDED_QUESTION_PACK?.id ?? "blank");
  const [stepIdx, setStepIdx] = useState(0);
  // Bulk edit spans several properties, where a per-property template step does not apply.
  const isBulkTemplateEditor = (propertyIds?.filter((id) => id.trim()).length ?? 0) > 0;
  // Round 31: every edit stays local until an explicit Save. `dirty` gates the Save button
  // and drives the discard confirmation so a stray click can never overwrite properties.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The workspace-wide application-form template (Settings → Application
  // form), fetched once per open so this listing's "Workspace form" /
  // "Custom for this listing" pick can show what it currently means and copy
  // it onto the listing exactly once when the manager switches to Custom.
  const [workspaceForm, setWorkspaceForm] = useState<WorkspaceApplicationFormTemplate | null>(null);
  const [workspaceFormLoaded, setWorkspaceFormLoaded] = useState(false);
  // P011: "Make default format" — pushes THIS custom config up to become the
  // account's workspace-wide default, through the same PATCH
  // Settings -> Forms already uses (recopies onto every OTHER listing that
  // still follows the workspace, via `recopyWorkspaceApplicationFormOntoFollowingListings`).
  const [makingDefault, setMakingDefault] = useState(false);
  const [importing, setImporting] = useState(false);
  /** F002: the file name shown on the dashed "Start from a file" card's reading state. */
  const [sectionsUploadFileName, setSectionsUploadFileName] = useState<string | null>(null);
  const [originalPdfPath, setOriginalPdfPath] = useState<string | null>(null);
  const [importedQuestionDraft, setImportedQuestionDraft] = useState<ApplicationTemplateQuestionConfig | null>(null);
  const [importIssues, setImportIssues] = useState<Array<{ pageNumber: number | null; code: string; message: string }>>([]);
  const [resolvedImportIssueIndexes, setResolvedImportIssueIndexes] = useState<number[]>([]);
  const [compareView, setCompareView] = useState<"original" | "form">("form");
  const [reviewingSource, setReviewingSource] = useState(false);
  // F004: a freshly parsed import, held here until the manager explicitly
  // applies it — picking a file must never silently replace what is already
  // on screen. `sourcePath` lets "Compare" show the Original PDF before Apply.
  const [pendingImport, setPendingImport] = useState<{
    draft: ApplicationTemplateQuestionConfig;
    issues: Array<{ pageNumber: number | null; code: string; message: string }>;
    sourcePath: string | null;
  } | null>(null);
  const [pendingImportCompareOpen, setPendingImportCompareOpen] = useState(false);
  const [questionDisplayOrder, setQuestionDisplayOrder] = useState<string[]>([]);
  // F-editor a: the Sections step's checklist — default sections the manager
  // unchecked for THIS template, hidden from the Form step below. See
  // `ApplicationTemplateQuestionConfig.disabledSectionIds`'s own doc comment.
  const [disabledSectionIds, setDisabledSectionIds] = useState<RentalApplicationSectionId[]>([]);
  const initializedEditorRef = useRef<string | null>(null);
  // F004/F007: a brand-new ("add" mode) application has no id until the
  // footer commit creates it. Generated once per open and reused both as the
  // storage/import id an in-progress "Sections" pick stages against and as
  // the created template's real id at commit, so a staged import's
  // `importProvenance.sourcePath` and a Setup "Default" pick both still
  // point at whatever template actually gets created.
  const [addModeTemplateId, setAddModeTemplateId] = useState<string | null>(null);
  const [startFrom, setStartFrom] = useState<PropertyFormStartFrom>("proplane");
  // The first step's per-template links. Held here (also for a template that is not saved yet) and
  // written with the template on Save; `initialLinks` is what the row showed on open, so a Save
  // that did not touch a row never rewrites its stored link.
  const [linkedLeaseId, setLinkedLeaseId] = useState<string | null>(null);
  const [linkedCosignerId, setLinkedCosignerId] = useState<string | null>(null);
  // Before the tour / After the tour / Use the workspace setting: saved on the form itself and
  // enforced server-side (`application-before-tour.server.ts`).
  const [tourOrder, setTourOrder] = useState<ApplicationTourOrder>("workspace");
  const initialLinksRef = useRef<{ lease: string | null; cosigner: string | null }>({ lease: null, cosigner: null });
  const [copyFromApplicationId, setCopyFromApplicationId] = useState<string | null>(null);
  const [questionsMobileSectionId, setQuestionsMobileSectionId] = useState<RentalApplicationSectionId>("personal");
  const replaceApplicationFileRef = useRef<HTMLInputElement>(null);
  const [routingLeaseTemplates, setRoutingLeaseTemplates] = useState<PropertyLeaseTemplate[]>([]);
  const [routingApplicationTemplates, setRoutingApplicationTemplates] = useState<PropertyApplicationTemplate[]>([]);
  const formSetup = usePropertyFormSetupSettings(applicationPreviewPropertyId);
  const leaseCatalog = useMemo(() => readPropertyLeaseTemplates(syncPropertyLeaseTemplatesFromListing(sub)), [sub]);

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
    setVariant(
      templateEditorMode === "add"
        ? "standard"
        : applicationTemplate
          ? applicationFormVariantForTemplate(applicationTemplate)
          : initialVariant,
    );
    setTemplateLabel(applicationTemplate?.label ?? "");
    setTemplateLabelError(null);
    setFeeOverrideEnabled(
      applicationTemplate?.feeCentsOverride !== null && applicationTemplate?.feeCentsOverride !== undefined,
    );
    setFeeOverrideCents(applicationTemplate?.feeCentsOverride ?? 0);
    setWaiverOverrideEnabled(Boolean(applicationTemplate?.waiverCodeOverride));
    setWaiverOverrideCode(applicationTemplate?.waiverCodeOverride ?? "");
    const importName =
      templateDraft?.importProvenance?.sourceName ??
      applicationTemplate?.publishedQuestionConfig?.importProvenance?.sourceName;
    setStartFrom(importName ? "upload" : "proplane");
    setCopyFromApplicationId(null);
    const initialLease = applicationTemplate
      ? leaseIdForApplication({ applications: templates ?? [], leases: leaseCatalog }, applicationTemplate.id)
      : null;
    const initialCosigner = applicationTemplate?.linkedCosignerApplicationTemplateId ?? null;
    initialLinksRef.current = { lease: initialLease, cosigner: initialCosigner };
    setLinkedLeaseId(initialLease);
    setLinkedCosignerId(initialCosigner);
    setTourOrder(normalizeApplicationTourOrder(applicationTemplate?.tourOrder));
    setQuestionsMobileSectionId("personal");
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
    setPendingImport(null);
    setPendingImportCompareOpen(false);
    setDisabledSectionIds(templateDraft?.disabledSectionIds?.slice() ?? []);
    setAddModeTemplateId(templateEditorMode === "add" ? makePropertyApplicationTemplateId() : null);
    setRoutingLeaseTemplates(leaseCatalog);
    setRoutingApplicationTemplates(readPropertyApplicationTemplates(sub));
  }, [open, sub, initialVariant, templateEditorMode, applicationTemplate, applicationPreviewPropertyId, templates, leaseCatalog]);

  const bulkIds = propertyIds?.filter((id) => id.trim()) ?? [];
  const isBulkSave = bulkIds.length > 0;

  // First-step link rows. A co-signer form maps to nothing and has no co-signer of its own.
  const leaseRowOptions = mappableLeaseTemplates(leaseCatalog).map((lease) => ({ value: lease.id, label: lease.label }));
  const cosignerFormOptions = (templates ?? [])
    .filter((template) => template.id !== applicationTemplate?.id && (isCosignerApplicationTemplate(template) || template.id === linkedCosignerId))
    .map((template) => ({ value: template.id, label: template.label }));
  const linkRowsAvailable = isTemplateEditor && !isBulkSave && variant !== "cosigner";
  const showLeaseRow =
    linkRowsAvailable &&
    signingOrder === "application_then_lease" &&
    (leaseRowOptions.length > 0 || linkedLeaseId !== null);
  const showCosignerRow = linkRowsAvailable && (cosignerFormOptions.length > 0 || linkedCosignerId !== null);

  // The real Applications tab (`pro-property-application-questions-panel.tsx`)
  // always opens this modal with a `templateEditorMode` — every row is a
  // named `PropertyApplicationTemplate` (Long-term / Short-term / Co-signer),
  // even for the ordinary single-listing edit path. `applicationFormSource`
  // is a LISTING-wide flag (all three variants switch together), not a
  // per-template one, so it must stay reachable in that mode too — only a
  // genuinely ambiguous multi-property BULK edit excludes it (`isBulkSave`).
  useEffect(() => {
    if (!open || isBulkSave) {
      setWorkspaceForm(null);
      setWorkspaceFormLoaded(false);
      return;
    }
    let cancelled = false;
    setWorkspaceFormLoaded(false);
    fetch("/api/portal/application-form")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { template?: WorkspaceApplicationFormTemplate } | null) => {
        if (cancelled) return;
        const template = data?.template;
        setWorkspaceForm(template && workspaceApplicationFormIsConfigured(template) ? template : null);
        setWorkspaceFormLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFormLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isBulkSave]);

  // Absent = "workspace" (follows the workspace template by default, see
  // `resolveEffectiveApplicationForm`); "custom" keeps this listing's own
  // triplet independent. Switching TO custom copies the workspace form onto
  // the listing ONCE, right now — the same "one-time copy, nothing stored as
  // a standing link" shape as "Same as Room X" (`listing-wizard-defaults.md`).
  const applicationFormSource: "workspace" | "custom" = localSub.applicationFormSource === "custom" ? "custom" : "workspace";
  const setApplicationFormSource = (next: "workspace" | "custom") => {
    if (next === applicationFormSource) return;
    setLocalSub((prev) => {
      if (next === "custom" && workspaceForm) {
        return {
          ...prev,
          applicationFormSource: "custom",
          customApplicationFields: workspaceForm.customApplicationFields,
          disabledStandardApplicationKeys: workspaceForm.disabledStandardApplicationKeys,
          applicationConfigMode: workspaceForm.applicationConfigMode,
          shortTermCustomApplicationFields: workspaceForm.shortTermCustomApplicationFields,
          shortTermDisabledStandardApplicationKeys: workspaceForm.shortTermDisabledStandardApplicationKeys,
          shortTermApplicationConfigMode: workspaceForm.shortTermApplicationConfigMode,
          cosignerCustomApplicationFields: workspaceForm.cosignerCustomApplicationFields,
          cosignerDisabledStandardApplicationKeys: workspaceForm.cosignerDisabledStandardApplicationKeys,
          cosignerApplicationConfigMode: workspaceForm.cosignerApplicationConfigMode,
        };
      }
      return { ...prev, applicationFormSource: next };
    });
    setDirty(true);
  };

  // F-editor b: the property Add/Edit application editor no longer offers a
  // "Workspace form / Custom for this listing" switch, or "Make default
  // format" — this property's application is always its OWN form, seeded
  // from the workspace template exactly the way "Custom for this listing"
  // already seeded it. A template that is still following the workspace
  // (never explicitly customized before this redesign) is detached from it
  // once, silently, the moment the workspace form finishes loading — the
  // same one-time copy as `setApplicationFormSource("custom")` above, minus
  // `setDirty`, because materializing the already-effective fields is not a
  // user edit. Nothing here touches the listing-wide editor (`isTemplateEditor`
  // is false there), which keeps the picker and its live "follows the
  // workspace" resolution untouched.
  useEffect(() => {
    if (!open || !isTemplateEditor || isBulkTemplateEditor) return;
    if (!workspaceFormLoaded || applicationFormSource === "custom") return;
    setLocalSub((prev) => (prev.applicationFormSource === "custom" ? prev : {
      ...prev,
      applicationFormSource: "custom",
      ...(workspaceForm
        ? {
            customApplicationFields: workspaceForm.customApplicationFields,
            disabledStandardApplicationKeys: workspaceForm.disabledStandardApplicationKeys,
            applicationConfigMode: workspaceForm.applicationConfigMode,
            shortTermCustomApplicationFields: workspaceForm.shortTermCustomApplicationFields,
            shortTermDisabledStandardApplicationKeys: workspaceForm.shortTermDisabledStandardApplicationKeys,
            shortTermApplicationConfigMode: workspaceForm.shortTermApplicationConfigMode,
            cosignerCustomApplicationFields: workspaceForm.cosignerCustomApplicationFields,
            cosignerDisabledStandardApplicationKeys: workspaceForm.cosignerDisabledStandardApplicationKeys,
            cosignerApplicationConfigMode: workspaceForm.cosignerApplicationConfigMode,
          }
        : {}),
    }));
  }, [open, isTemplateEditor, isBulkTemplateEditor, workspaceFormLoaded, workspaceForm, applicationFormSource]);

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
    // C195: SSN, ID and income join the identity trio in never being
    // removable — screening/charges/leases read them directly and a manager
    // hiding one breaks approval with no error at disable-time. Unlike the
    // identity trio, only removal is locked here: label and required stay
    // editable (income in particular is meant to stay optional).
    if (action === "visibility" && NEVER_DISABLED_STANDARD_KEY_SET.has(key)) return false;
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

  // While this listing follows the workspace template, DISPLAY (fields,
  // preview) resolves from the workspace's questions, not the listing's own
  // (currently inactive) triplet — `renderSection` below shows that resolved
  // set read-only rather than the editable builder, so nothing here writes
  // an edit that the next render would silently discard.
  const effectiveSubForDisplay = useMemo(
    () => (applicationFormSource === "workspace" ? applyEffectiveApplicationForm(localSub, workspaceForm) : localSub),
    [localSub, workspaceForm, applicationFormSource],
  );

  // The config slice for the form the manager is editing.
  // top-level triplet; short-term reads its own, defaulting to PropLane's
  // curated short-term question set until edited. Edits to one never touch the
  // other.
  const configSlice = useMemo(() => ({
    ...applicationConfigForVariant(effectiveSubForDisplay, variant),
    questionDisplayOrder,
  }), [effectiveSubForDisplay, questionDisplayOrder, variant]);

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

  // F004: the staged import's own field list, resolved the same way
  // `applicationFields` is, so the diff compares like with like.
  const pendingImportFields = useMemo(
    () => (pendingImport ? resolveListingApplicationFields(pendingImport.draft, normalizeCustomApplicationFieldsForEditor) : null),
    [pendingImport],
  );
  const pendingImportDiff = useMemo(
    () =>
      pendingImportFields
        ? diffImportSections(
            applicationFieldsToImportSections(applicationFields),
            applicationFieldsToImportSections(pendingImportFields),
          )
        : null,
    [applicationFields, pendingImportFields],
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

  const visibleQuestionSections = useMemo(
    () => RENTAL_APPLICATION_SECTIONS.filter((section) => section.id !== "review" && !disabledSectionIds.includes(section.id)),
    [disabledSectionIds],
  );

  const previewStepPosition = useMemo(() => {
    const index = visibleQuestionSections.findIndex((section) => section.id === previewSectionId);
    if (index < 0) return null;
    return { index: index + 1, total: visibleQuestionSections.length };
  }, [previewSectionId, visibleQuestionSections]);

  const startFromFactLabel = useMemo(() => {
    const provenance =
      importedQuestionDraft?.importProvenance ??
      applicationTemplate?.draftQuestionConfig?.importProvenance ??
      applicationTemplate?.publishedQuestionConfig?.importProvenance;
    if (provenance?.sourceName?.trim()) return provenance.sourceName.trim();
    if (provenance?.sourcePath) return "Uploaded PDF";
    return variant === "cosigner" ? "PropLane standard co-signer" : "PropLane standard";
  }, [applicationTemplate, importedQuestionDraft, variant]);

  const copyApplicationOptions = useMemo(
    () =>
      (templates ?? [])
        .filter((candidate) => candidate.id !== applicationTemplate?.id)
        .map((candidate) => ({ value: candidate.id, label: candidate.label })),
    [applicationTemplate?.id, templates],
  );

  const workspaceSteps = useMemo<AddWorkspaceStep[]>(() => {
    const questionSummary = (sectionId: string) => {
      const n = applicationFields.filter((f) => (f.section ?? "additional") === sectionId).length;
      return n === 1 ? "1 question" : `${n} questions`;
    };
    if (isTemplateEditor) {
      // P002: the property Add/Edit application editor — Name -> Questions. The
      // Settings step is gone (C2-CP8): workspace choices live in Settings ->
      // Applications & leases, property switches on the Application tab's gear. Matches the studio
      // After (proto/property-forms.js ED_STEPS); the listing-wide editor
      // below (opened outside a property record) keeps its own separate
      // per-section step rail, out of scope for this collapse.
      // F003: a section the manager unchecked drops out of every count too.
      const includedSectionIds = new Set(
        RENTAL_APPLICATION_SECTIONS.filter((s) => s.id !== "review" && !disabledSectionIds.includes(s.id)).map((s) => s.id),
      );
      const totalQuestions = applicationFields.filter((f) => includedSectionIds.has((f.section ?? "additional") as RentalApplicationSectionId)).length;
      return [
        { id: "name", label: "Application", incomplete: !templateLabel.trim(), summary: templateLabel.trim() || "Name this application" },
        {
          id: "sections",
          label: "Questions",
          summary: `${totalQuestions === 1 ? "1 question" : `${totalQuestions} questions`} · ${includedSectionIds.size === 1 ? "1 section" : `${includedSectionIds.size} sections`}`,
        },
      ];
    }
    const head: AddWorkspaceStep[] = lockVariant
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
  }, [
    applicationFields,
    isTemplateEditor,
    lockVariant,
    templateLabel,
    variant,
  ]);

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
      if (duplicateTemplateNameError) return;
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

    // P003 / C2-R30-4: the editor no longer offers a fee or promo code (room
    // pricing owns it), but checkout still honours a template's stored
    // override — so a save carries it through untouched rather than silently
    // resetting what applicants are charged.
    const feeCentsOverride = applicationTemplate?.feeCentsOverride ?? null;
    const waiverCodeOverride = applicationTemplate?.waiverCodeOverride ?? null;
    if (isTemplateEditor && templates && onPersistSubmission) {
      const trimmed = templateLabel.trim();
      const catalogApplications =
        routingApplicationTemplates.length > 0 ? routingApplicationTemplates : templates;
      let nextTemplates: PropertyApplicationTemplate[];
      if (templateEditorMode === "add") {
        nextTemplates = [
          ...catalogApplications,
          {
            ...createPropertyApplicationTemplate({ kind: "long-term", label: trimmed }),
            // F004/F007: reuse the SAME id a staged import was parsed
            // against (and a Setup "Default" pick already wrote to this
            // property's settings) — otherwise either would end up pointing
            // at an id no template ever ends up with.
            id: addModeTemplateId ?? makePropertyApplicationTemplateId(),
            feeCentsOverride,
            waiverCodeOverride,
            tourOrder,
            draftQuestionConfig: {
              ...applicationTemplateQuestionConfigFromSlice(
                applicationConfigForVariant(sanitizedSub, "standard"),
                // F004: carries a staged-then-applied import's `importProvenance`
                // (source name/path/sha, issues) onto the newly created
                // template — the PDF was already parsed and stored at Apply
                // time; nothing here re-parses or re-uploads it.
                importedQuestionDraft ?? undefined,
              ),
              questionDisplayOrder: applicationFields.map((field) => field.id),
              disabledSectionIds: [...disabledSectionIds],
            },
          },
        ];
      } else {
        const templateVariant = applicationFormVariantForTemplate(applicationTemplate!);
        nextTemplates = updatePropertyApplicationTemplate(catalogApplications, applicationTemplate!.id, {
          label: trimmed,
          feeCentsOverride,
          waiverCodeOverride,
          tourOrder,
          draftQuestionConfig: {
            ...applicationTemplateQuestionConfigFromSlice(
              applicationConfigForVariant(sanitizedSub, templateVariant),
              importedQuestionDraft ?? draftQuestionConfigForTemplate(applicationTemplate!),
            ),
            questionDisplayOrder: configSlice.questionDisplayOrder,
            disabledSectionIds: [...disabledSectionIds],
          },
        });
      }
      // The first step's links ride with the template (also a brand-new one): the same
      // `setMappingTarget` path Settings used, so an application still carries ONE lease.
      const savedTemplateId =
        templateEditorMode === "add" ? nextTemplates[nextTemplates.length - 1]?.id : applicationTemplate?.id;
      if (savedTemplateId && variant !== "cosigner") {
        if (showLeaseRow && linkedLeaseId !== initialLinksRef.current.lease) {
          const mapped = setMappingTarget(
            "application_then_lease",
            { applications: nextTemplates, leases: leaseCatalog },
            savedTemplateId,
            linkedLeaseId,
          );
          if (!mapped.ok) {
            setSaving(false);
            setSaveError(mapped.error);
            return;
          }
          nextTemplates = mapped.applications;
        }
        if (showCosignerRow && linkedCosignerId !== initialLinksRef.current.cosigner) {
          nextTemplates = updatePropertyApplicationTemplate(nextTemplates, savedTemplateId, {
            linkedCosignerApplicationTemplateId: linkedCosignerId,
          });
        }
      }
      // Template edits must not mutate the listing-wide legacy triplet. That
      // triplet remains the fallback for templates created before versioning.
      // F-editor c: the footer Save/Add button is the ONLY commit action now
      // (the in-body "Publish application" button is gone) — it tries to
      // publish, but a failed gate falls back to an ordinary draft save
      // rather than discarding the manager's edits. Losing unsaved work to a
      // publish-readiness check would be worse than landing on Setup with a
      // draft that is not live yet.
      let publishTarget: PropertyApplicationTemplate | null = null;
      let publishBlockedReason: string | null = null;
      if (publish) {
        const target = nextTemplates.find((template) =>
          template.id === applicationTemplate?.id || (templateEditorMode === "add" && template.label === trimmed),
        );
        if (!target) {
          publishBlockedReason = "Could not prepare this application for publishing.";
        } else {
          const gate = applicationTemplateQuestionPublishGate(target);
          if (gate.ok) {
            publishTarget = target;
          } else {
            publishBlockedReason = gate.reason;
          }
        }
      }
      const merged = withPropertyApplicationTemplatesExplicit(sub, nextTemplates);
      const withLeases = syncLegacyLeaseFieldsFromTemplates(merged, routingLeaseTemplates);
      const okSaved = await onPersistSubmission(withLeases, {
        message: publishTarget
          ? "Application published."
          : publishBlockedReason
            ? `Saved as a draft — ${publishBlockedReason}`
            : templateEditorMode === "add"
              ? "Application added."
              : "Application saved.",
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

  type StagedApplicationImport = {
    draft: ApplicationTemplateQuestionConfig;
    issues: Array<{ pageNumber: number | null; code: string; message: string }>;
    sourcePath: string | null;
  };

  // F004: parses the uploaded PDF and STAGES the result — nothing on screen
  // changes yet, and nothing is persisted (a brand-new "add" application has
  // no saved template row at all until the footer commit creates one).
  // `applyPendingImport` below is the only thing that writes it into the
  // template being edited. Works the same for a new template (staged against
  // `addModeTemplateId`, reused as the real id at commit) and an
  // existing one (`applicationTemplate.id`) — picking a file on the Sections
  // card never distinguishes the two any more.
  const importPdf = async (file: File): Promise<StagedApplicationImport | null> => {
    const templateIdForImport = applicationTemplate?.id ?? addModeTemplateId;
    if (!templateIdForImport || !applicationPreviewPropertyId || isBulkSave) return null;
    setImporting(true);
    try {
      const body = new FormData();
      body.set("propertyId", applicationPreviewPropertyId);
      body.set("templateId", templateIdForImport);
      body.set("file", file);
      const response = await fetch("/api/portal/application-template-import", { method: "POST", body });
      const result = await response.json().catch(() => null) as { error?: string; draft?: ApplicationTemplateQuestionConfig; source?: { path?: string }; issues?: Array<{ pageNumber: number | null; code: string; message: string }> } | null;
      if (!response.ok || !result) throw new Error(result?.error || "Could not import the application PDF.");
      if (!result.draft) throw new Error("Could not read any questions from that PDF.");
      const staged: StagedApplicationImport = { draft: result.draft, issues: result.issues ?? [], sourcePath: result.source?.path ?? null };
      setPendingImport(staged);
      setPendingImportCompareOpen(false);
      return staged;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not import the application PDF.");
      return null;
    } finally {
      setImporting(false);
    }
  };

  // F004: writes a staged import into the template being edited — the same
  // state `importPdf`'s success branch used to set immediately. This is the
  // ONLY place that happens; picking a file never does it on its own. Works
  // in "add" mode too (`applicationTemplate` is null there): the variant
  // falls back to "standard", the only variant a brand-new template can be.
  const applyPendingImport = (staged: StagedApplicationImport | null = pendingImport) => {
    if (!staged) return;
    const { draft, issues, sourcePath } = staged;
    const importVariant = applicationTemplate ? applicationFormVariantForTemplate(applicationTemplate) : "standard";
    setOriginalPdfPath(sourcePath);
    setImportIssues(issues);
    setResolvedImportIssueIndexes([]);
    setImportedQuestionDraft(draft);
    setQuestionDisplayOrder(draft.questionDisplayOrder ?? []);
    setLocalSub((previous) => ({
      ...previous,
      ...mergeApplicationConfigForVariant(importVariant, draft),
    }));
    setDirty(true);
    setPendingImport(null);
    setPendingImportCompareOpen(false);
    showToast(issues.length ? "Applied. Resolve the flagged source issues before publishing." : "Applied the imported questions.");
  };

  // F004: drops the staged import. The template is left exactly as it was —
  // nothing that `applyPendingImport` would have written is touched.
  const discardPendingImport = () => {
    setPendingImport(null);
    setPendingImportCompareOpen(false);
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

  // F-editor a: a section holding a never-removable standard field (identity
  // trio, SSN/ID, income) can never actually drop to zero questions, so its
  // Sections-step checklist entry stays locked checked rather than offering
  // an uncheck that would not do anything.
  const sectionHasLockedField = (sectionId: RentalApplicationSectionId): boolean =>
    [...applicationFields, ...disabledFields].some(
      (field) => (field.section ?? "additional") === sectionId && Boolean(field.standardKey) && NEVER_DISABLED_STANDARD_KEY_SET.has(field.standardKey!),
    );

  /** Unchecking drops every standard question in the section that can be turned off (never a custom one the manager wrote). Re-checking brings them back. */
  useEffect(() => {
    if (!open || templateEditorMode !== "add" || startFrom !== "copy" || !copyFromApplicationId) return;
    const src = templates?.find((candidate) => candidate.id === copyFromApplicationId);
    if (!src) return;
    const draft = draftQuestionConfigForTemplate(src);
    if (!draft) return;
    const copiedVariant = applicationFormVariantForTemplate(src);
    setVariant(copiedVariant);
    setLocalSub((prev) => ({ ...prev, ...mergeApplicationConfigForVariant(copiedVariant, draft) }));
    setDisabledSectionIds(draft.disabledSectionIds?.slice() ?? []);
    if (!templateLabel.trim()) setTemplateLabel(`${src.label} copy`);
    setDirty(true);
  }, [copyFromApplicationId, open, startFrom, templateEditorMode, templates, templateLabel]);

  const addQuestionSection = (): void => {
    const next = RENTAL_APPLICATION_SECTIONS.find(
      (section) => section.id !== "review" && disabledSectionIds.includes(section.id),
    );
    if (next) toggleSection(next.id, true);
  };

  const toggleSection = (sectionId: RentalApplicationSectionId, on: boolean): void => {
    if (!on && sectionHasLockedField(sectionId)) return;
    let nextConfig: ApplicationConfigSlice = configSlice;
    if (!on) {
      for (const field of applicationFields) {
        if ((field.section ?? "additional") !== sectionId || !field.isStandard) continue;
        if (!canEditBuiltIn(field, "visibility")) continue;
        nextConfig = { ...nextConfig, ...removeListingApplicationField(nextConfig, field) };
      }
    } else {
      for (const field of disabledFields) {
        if ((field.section ?? "additional") !== sectionId || !field.standardKey) continue;
        nextConfig = { ...nextConfig, ...reenableListingApplicationField(nextConfig, field.standardKey) };
      }
    }
    applyEditedSlice(nextConfig);
    setDisabledSectionIds((prev) =>
      on ? prev.filter((id) => id !== sectionId) : prev.includes(sectionId) ? prev : [...prev, sectionId],
    );
  };

  const patchField = (field: ResolvedApplicationField, patch: Partial<ManagerCustomApplicationField>) => {
    if ((patch.label !== undefined && !canEditBuiltIn(field, "label")) ||
      (patch.required !== undefined && !canEditBuiltIn(field, "required")) ||
      (patch.options !== undefined && field.isStandard && field.options.length > 0) ||
      (patch.type !== undefined && variant === "cosigner" && !field.isStandard && (patch.type === "file" || patch.type === "photos"))) return;
    applyEditedSlice(patchListingApplicationField(configSlice, field, patch));
  };

  const toggleQuestionExpand = (fieldId: string) => {
    const field = applicationFields.find((candidate) => candidate.id === fieldId);
    if (field?.section) {
      setPreviewSectionPick(field.section as RentalApplicationSectionId);
      setQuestionsMobileSectionId(field.section as RentalApplicationSectionId);
    }
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

  /**
   * P011: "Make default format" — pushes this listing's current custom
   * question config up to become the WORKSPACE'S default application form,
   * through the exact same `PATCH /api/portal/application-form` Settings ->
   * Forms already uses (so it also recopies onto every OTHER listing still
   * following the workspace — one write, one recipient of the change, never
   * a second "default" concept invented here).
   */
  const makeDefaultFormat = async () => {
    if (makingDefault) return;
    setMakingDefault(true);
    try {
      const base = workspaceForm ?? emptyWorkspaceApplicationFormTemplate();
      const template: WorkspaceApplicationFormTemplate =
        variant === "short_term"
          ? {
              ...base,
              shortTermCustomApplicationFields: localSub.shortTermCustomApplicationFields ?? [],
              shortTermDisabledStandardApplicationKeys: localSub.shortTermDisabledStandardApplicationKeys ?? [],
              shortTermApplicationConfigMode: localSub.shortTermApplicationConfigMode ?? "custom",
            }
          : variant === "cosigner"
            ? {
                ...base,
                cosignerCustomApplicationFields: localSub.cosignerCustomApplicationFields ?? [],
                cosignerDisabledStandardApplicationKeys: localSub.cosignerDisabledStandardApplicationKeys ?? [],
                cosignerApplicationConfigMode: localSub.cosignerApplicationConfigMode ?? "custom",
              }
            : {
                ...base,
                customApplicationFields: localSub.customApplicationFields ?? [],
                disabledStandardApplicationKeys: localSub.disabledStandardApplicationKeys ?? [],
                applicationConfigMode: localSub.applicationConfigMode ?? "custom",
              };
      const res = await fetch("/api/portal/application-form", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template }),
      });
      const data = (await res.json().catch(() => null)) as { template?: WorkspaceApplicationFormTemplate; error?: string } | null;
      if (!res.ok || !data?.template) {
        showToast(data?.error ?? "Could not make this the default format.");
        return;
      }
      setWorkspaceForm(workspaceApplicationFormIsConfigured(data.template) ? data.template : null);
      showToast("This is now the default application format for the workspace.");
    } catch {
      showToast("Could not make this the default format.");
    } finally {
      setMakingDefault(false);
    }
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

  // F001: inline duplicate-name validation — another application already
  // saved on this property with the same (trimmed, case-insensitive) name.
  const duplicateTemplateNameError = isTemplateEditor
    ? duplicateApplicationNameError(templateLabel, templates, applicationTemplate?.id)
    : null;
  const nameStepError = templateLabelError || duplicateTemplateNameError;

  const renderSection = (sectionId: RentalApplicationSectionId) => {
    const sectionQuestions = applicationFields.filter((f) => (f.section ?? "additional") === sectionId);
    const sectionDisabled = disabledFields.filter((f) => (f.section ?? "additional") === sectionId);
    if (applicationFormSource === "workspace" && workspaceForm && !isBulkSave) {
      return (
        <div data-attr={`application-section-toggle-${sectionId}`} className="space-y-3">
          <p className="text-sm text-muted">
            Following the workspace application form. Pick &quot;Custom for this listing&quot; above to edit this
            listing&apos;s own questions.
          </p>
          {sectionQuestions.length === 0 ? (
            <p className="text-sm text-muted">No questions in this section.</p>
          ) : (
            <ApplicationSectionPreviewPane
              section={RENTAL_APPLICATION_SECTIONS.find((s) => s.id === sectionId) ?? null}
              fields={sectionQuestions}
              applicationPreviewPropertyId={applicationPreviewPropertyId}
            />
          )}
        </div>
      );
    }
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

  // Rendered on whichever entry step is actually present — the real
  // Applications tab always opens this modal in `templateEditorMode` (step
  // "name"), never the plain "form" step; both render it so it is reachable
  // either way. `applicationFormSource` is listing-wide, not per-template.
  const applicationFormSourcePicker =
    !isBulkSave && workspaceFormLoaded ? (
      <div>
        <FieldSingleSelect
          label="Application form"
          labelClassName={WIZARD_LABEL_CLASS}
          value={applicationFormSource}
          dataAttr="application-form-source"
          options={[
            { value: "workspace", label: workspaceForm ? "Workspace form" : "Workspace form (not set up yet)" },
            { value: "custom", label: "Custom for this listing" },
          ]}
          onChange={(next) => setApplicationFormSource(next as "workspace" | "custom")}
        />
        {/* P011: PropLane's built-in defaults are reached the same way every
            other "start over" affordance in this editor already works — the
            Form step's "Reset all standard questions" action (immediately
            below) — rather than a third persisted format value; see the
            build report for why a genuinely separate stored "standard" state
            was scoped out. "Make default format" IS the other explicit ask
            and is real: it pushes this custom config to the workspace. */}

      </div>
    ) : null;

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

  // P002: everything the old dedicated "Preview" step showed beyond the
  // single-section `previewBody` above — the imported-PDF comparison and the
  // full embedded applicant wizard preview. Shared by the template editor's
  // "Form" step (tail, P002's 3-step collapse) and the listing-wide editor's
  // still-separate "Preview" step, so neither path duplicates this JSX.
  const previewExtras = (
    <>
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
    </>
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
            stepPosition={previewStepPosition}
          />
        }
        lastLabel={templateEditorMode === "add" ? "Create application" : "Save"}
        lastDisabled={saving || (isTemplateEditor ? !templateLabel.trim() || Boolean(duplicateTemplateNameError) : !dirty) || hasFieldErrors || Boolean(pendingImport)}
        onBeforeNext={() => {
          if (stepId === "name" && !templateLabel.trim()) {
            setTemplateLabelError("Enter a name for this application.");
            return false;
          }
          if (stepId === "name" && duplicateTemplateNameError) return false;
          return true;
        }}
        busy={saving}
        // F-editor c: footer-only commit. The old separate "Publish
        // application" button is gone — the same footer Save/Add action
        // now tries to publish for a single-property template editor, and
        // falls back to an ordinary draft save (see commitSave) when the
        // publish gate is not satisfied yet.
        onFinish={() => void commitSave({ publish: isTemplateEditor && !isBulkTemplateEditor })}
        saveState={saving ? "Saving…" : dirty ? "Not saved yet" : "Saved"}
        dataAttrPrefix="application-questions"
        numberedSteps={false}
        hideFooterStepCount
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
            <StepHeading title="Application" />
            {isTemplateEditor && !isBulkSave ? (
              <PropertyFormWizardCard dataAttr="property-application-step-one-card">
                {templateEditorMode === "edit" ? (
                  <PropertyFormWizardRow label="Form type">
                    <span className="text-sm font-semibold text-foreground" data-attr="application-form-type-fact">
                      {variant === "cosigner" ? "Co-signer" : "Standard"}
                    </span>
                  </PropertyFormWizardRow>
                ) : (
                  <PropertyFormWizardRow label="Form type">
                    <FieldSingleSelect
                      hideLabel
                      label="Form type"
                      labelClassName={WIZARD_LABEL_CLASS}
                      variant="cell"
                      className="min-w-[200px] max-w-[280px]"
                      value={variant === "cosigner" ? "cosigner" : "standard"}
                      dataAttr="application-form-type"
                      options={[
                        { value: "standard", label: "Standard" },
                        { value: "cosigner", label: "Co-signer" },
                      ]}
                      onChange={(next) => {
                        setVariant(next === "cosigner" ? "cosigner" : "standard");
                        setDirty(true);
                      }}
                    />
                  </PropertyFormWizardRow>
                )}
                {templateEditorMode === "add" ? (
                  <PropertyFormWizardRow label="Start from">
                    <PropertyFormStartFromSelect
                      value={startFrom}
                      dataAttr="property-application-start-from"
                      onChange={(next) => {
                        setStartFrom(next);
                        if (next !== "copy") setCopyFromApplicationId(null);
                      }}
                    />
                  </PropertyFormWizardRow>
                ) : (
                  <PropertyFormWizardRow label="Start from">
                    <PropertyFormStartFromFact
                      label={startFromFactLabel}
                      factDataAttr="application-start-from-fact"
                      onReplace={
                        startFromFactLabel !== "PropLane standard" &&
                        startFromFactLabel !== "PropLane standard co-signer" &&
                        applicationPreviewPropertyId
                          ? () => replaceApplicationFileRef.current?.click()
                          : undefined
                      }
                      replaceDataAttr="application-replace-upload"
                    />
                  </PropertyFormWizardRow>
                )}
                {templateEditorMode === "add" && startFrom === "copy" ? (
                  <PropertyFormWizardRow label="Copy existing">
                    <FieldSingleSelect
                      hideLabel
                      label="Copy existing"
                      labelClassName={WIZARD_LABEL_CLASS}
                      variant="cell"
                      className="min-w-[200px] max-w-[280px]"
                      value={copyFromApplicationId ?? ""}
                      dataAttr="application-copy-existing"
                      options={copyApplicationOptions}
                      placeholder="Choose an application"
                      onChange={(next) => setCopyFromApplicationId(next || null)}
                    />
                  </PropertyFormWizardRow>
                ) : null}
                {linkRowsAvailable ? (
                  <PropertyFormWizardRow label="Tour order">
                    <FieldSingleSelect
                      hideLabel
                      label="Tour order"
                      labelClassName={WIZARD_LABEL_CLASS}
                      variant="cell"
                      className="min-w-[200px] max-w-[280px]"
                      value={tourOrder}
                      dataAttr="application-tour-order"
                      options={APPLICATION_TOUR_ORDER_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                      onChange={(next) => {
                        setTourOrder(normalizeApplicationTourOrder(next));
                        setDirty(true);
                      }}
                    />
                  </PropertyFormWizardRow>
                ) : null}
                {showLeaseRow ? (
                  <PropertyFormWizardRow label="Lease">
                    <FieldSingleSelect
                      hideLabel
                      label="Lease"
                      labelClassName={WIZARD_LABEL_CLASS}
                      variant="cell"
                      className="min-w-[200px] max-w-[280px]"
                      value={linkedLeaseId ?? NO_LINK}
                      dataAttr="application-lease-link"
                      options={[{ value: NO_LINK, label: "Not mapped" }, ...leaseRowOptions]}
                      onChange={(next) => {
                        const target = next === NO_LINK ? null : next;
                        const problem = mappingTargetError("application_then_lease", { applications: templates ?? [], leases: leaseCatalog }, target);
                        if (problem) {
                          setSaveError(problem);
                          return;
                        }
                        setSaveError(null);
                        setLinkedLeaseId(target);
                        setDirty(true);
                      }}
                    />
                  </PropertyFormWizardRow>
                ) : null}
                {showCosignerRow ? (
                  <PropertyFormWizardRow label="Co-signer form">
                    <FieldSingleSelect
                      hideLabel
                      label="Co-signer form"
                      labelClassName={WIZARD_LABEL_CLASS}
                      variant="cell"
                      className="min-w-[200px] max-w-[280px]"
                      value={linkedCosignerId ?? NO_LINK}
                      dataAttr="application-cosigner-form-link"
                      options={[{ value: NO_LINK, label: "Property default" }, ...cosignerFormOptions]}
                      onChange={(next) => {
                        setLinkedCosignerId(next === NO_LINK ? null : next);
                        setDirty(true);
                      }}
                    />
                  </PropertyFormWizardRow>
                ) : null}
              </PropertyFormWizardCard>
            ) : null}
            <input
              ref={replaceApplicationFileRef}
              type="file"
              className="hidden"
              accept="application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              data-attr="application-replace-upload-input"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = "";
                if (!file || !applicationPreviewPropertyId) return;
                setSectionsUploadFileName(file.name);
                void importPdf(file);
              }}
            />
            {isTemplateEditor && templateEditorMode === "add" && startFrom === "upload" && applicationPreviewPropertyId && !isBulkSave ? <ImportFileStrip
              dataAttr="property-application-start-from-file"
              chips={[".pdf", ".docx", "Your current application", "up to 5 MB"]}
              accept="application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              busy={importing}
              state={
                importing
                  ? { kind: "reading", fileName: sectionsUploadFileName ?? "your file" }
                  : { kind: "blank" }
              }
              onPickFile={(file) => {
                setSectionsUploadFileName(file.name);
                if (isTemplateEditor && applicationPreviewPropertyId && !isBulkSave) {
                  void importPdf(file);
                }
              }}
              onReread={() => {}}
            /> : null}
            {/* F004: a freshly parsed import waits here — nothing above or
                below has changed yet. "Apply changes" is the only thing that
                writes it in; "Discard" drops it and leaves the template
                exactly as it was. */}
            {pendingImport && pendingImportDiff ? (
              <div className="mb-4 rounded-2xl border border-primary/40 bg-primary/[0.04] p-3.5" data-attr="application-pending-import">
                <p className="text-[13.5px] font-bold text-foreground" data-attr="application-pending-import-summary">
                  {pendingImportDiff.totalIncoming} section{pendingImportDiff.totalIncoming === 1 ? "" : "s"} found · {pendingImportDiff.changedCount === 0 ? "up to date" : `${pendingImportDiff.changedCount} changed`}
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" className="rounded-full" onClick={() => setPendingImportCompareOpen((v) => !v)} data-attr="application-pending-import-compare">
                    {pendingImportCompareOpen ? "Hide compare" : "Compare"}
                  </Button>
                  <Button type="button" variant="primary" className="rounded-full" onClick={() => applyPendingImport()} data-attr="application-pending-import-apply">
                    Apply changes from the file
                  </Button>
                  <Button type="button" variant="outline" className="rounded-full" onClick={discardPendingImport} data-attr="application-pending-import-discard">
                    Discard
                  </Button>
                </div>
                {pendingImportCompareOpen ? (
                  <ul className="mt-3 space-y-2" data-attr="application-pending-import-changed-sections">
                    {changedSectionEntries(pendingImportDiff).length === 0 ? (
                      <li className="text-[13px] text-muted">No sections changed.</li>
                    ) : (
                      changedSectionEntries(pendingImportDiff).map((entry) => (
                        <li key={entry.key} className="rounded-xl border border-border bg-card p-2.5 text-[13px]" data-attr="application-pending-import-changed-section">
                          <p className="font-semibold text-foreground">
                            {entry.title} <span className="font-normal text-muted">({entry.status})</span>
                          </p>
                          <div className="mt-1 grid gap-2 sm:grid-cols-2">
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Current</p>
                              <p className="whitespace-pre-line text-foreground/80">{entry.currentBody || "—"}</p>
                            </div>
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">From the file</p>
                              <p className="whitespace-pre-line text-foreground/80">{entry.incomingBody || "—"}</p>
                            </div>
                          </div>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="mt-4">
              <FloatingLabelField
                id="application-template-name"
                label="Application name"
                placeholder="Application name"
                value={templateLabel}
                error={nameStepError}
                dataAttr="property-application-name"
                onChange={(next) => {
                  setTemplateLabel(next);
                  setTemplateLabelError(null);
                  setDirty(true);
                }}
              />
            </div>
            {templateEditorMode === "edit" && applicationPreviewPropertyId && !isBulkSave ? (
              <PropertyFormUsedForMapping
                sub={sub}
                pipelineOrder={formSetup.leasingPipeline.pipelineOrder}
                mode="application"
                currentApplicationId={applicationTemplate?.id}
                leaseTemplates={routingLeaseTemplates}
                applicationTemplates={routingApplicationTemplates}
                onLeaseTemplatesChange={(next) => {
                  setRoutingLeaseTemplates(next);
                  setDirty(true);
                }}
                onApplicationTemplatesChange={(next) => {
                  setRoutingApplicationTemplates(next);
                  setDirty(true);
                }}
                onError={(message) => setSaveError(message)}
              />
            ) : null}
            {templateEditorMode === "edit" && applicationTemplate?.id && applicationPreviewPropertyId && !isBulkSave ? (
              <PropertyFormFeeForCurrentForm
                sub={sub}
                mode="application"
                currentId={applicationTemplate.id}
                leaseTemplates={routingLeaseTemplates}
                applicationTemplates={routingApplicationTemplates}
                propertyId={applicationPreviewPropertyId}
              />
            ) : null}
            {isTemplateEditor && applicationTemplate && applicationPreviewPropertyId && !isBulkSave &&
            (originalPdfPath || (importedQuestionDraft ?? applicationTemplate?.draftQuestionConfig)?.importProvenance?.sourceSha256) ? (
              <div className="mt-3 flex flex-wrap gap-2">
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
              <ul className="mt-2 space-y-1 text-sm text-muted" data-attr="application-import-issues">
                {importIssues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.pageNumber ?? "document"}-${index}`}>
                    {issue.pageNumber ? `Page ${issue.pageNumber}: ` : "Document: "}{issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </StepColumn>
        ) : null}
        {stepId === "form" ? (
          <StepColumn>
            <StepHeading
              title="Form"
              action={
                <div className="flex items-center gap-2">
                  <PortalIconAction ring icon={RotateCcw} label={restoreLabel} onClick={restoreDefaults} />
                  {applicationFormSource === "custom" ? (
                    <PortalIconAction ring icon={Star} label={makingDefault ? "Making default…" : "Make default format"} disabled={makingDefault} data-attr="application-form-make-default" onClick={() => void makeDefaultFormat()} />
                  ) : null}
                </div>
              }
            />
            {applicationFormSourcePicker}
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
        {stepId === "sections" ? (
          <StepColumn>
            <StepHeading
              title="Questions"
              action={
                <button type="button" className="text-xs font-semibold text-primary underline-offset-2 hover:underline" onClick={restoreDefaults}>
                  {restoreLabel}
                </button>
              }
            />
            {(importedQuestionDraft?.importProvenance || applicationTemplate?.draftQuestionConfig?.importProvenance) ? (
              <div
                className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm"
                data-attr="application-detected-fields"
              >
                <span className="font-semibold text-foreground">
                  {applicationFields.length === 1 ? "1 fillable field" : `${applicationFields.length} fillable fields`} detected
                </span>
              </div>
            ) : null}
            <div className="mb-3 space-y-2 lg:hidden" data-attr="application-questions-section-picker">
              <FieldSingleSelect
                label="Section"
                labelClassName={WIZARD_LABEL_CLASS}
                value={questionsMobileSectionId}
                dataAttr="application-questions-section"
                options={visibleQuestionSections.map((section) => ({
                  value: section.id,
                  label: section.title,
                }))}
                onChange={(next) => {
                  const id = next as RentalApplicationSectionId;
                  setQuestionsMobileSectionId(id);
                  setPreviewSectionPick(id);
                  setExpandedSectionIds((prev) => new Set(prev).add(id));
                }}
              />
            </div>
            <div className="mb-4 space-y-2" data-attr="application-sections-checklist">
              {RENTAL_APPLICATION_SECTIONS.filter((section) => section.id !== "review").map((section) => {
                const count = applicationFields.filter((f) => (f.section ?? "additional") === section.id).length;
                const on = !disabledSectionIds.includes(section.id);
                const locked = on && sectionHasLockedField(section.id);
                return (
                  <label
                    key={section.id}
                    className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 has-[:disabled]:cursor-not-allowed"
                  >
                    <span className="flex items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={locked}
                        onChange={(e) => toggleSection(section.id, e.target.checked)}
                        className="h-4 w-4 rounded border-border text-primary"
                        data-attr={`application-sections-checklist-${section.id}`}
                      />
                      <span className="text-[13.5px] font-semibold text-foreground">{section.title}</span>
                    </span>
                    <span className="text-xs text-muted">{count === 1 ? "1 question" : `${count} questions`}</span>
                  </label>
                );
              })}
            </div>
            <div className="space-y-2">
              {visibleQuestionSections.map((section) => {
                const n = applicationFields.filter((f) => (f.section ?? "additional") === section.id).length;
                return (
                  <PortalCollapsibleEditRow
                    key={section.id}
                    title={section.title}
                    subtitle={n === 1 ? "1 question" : `${n} questions`}
                    expanded={expandedSectionIds.has(section.id)}
                    onExpandedChange={(next) => {
                      if (next) {
                        setPreviewSectionPick(section.id);
                        setQuestionsMobileSectionId(section.id);
                      }
                      setExpandedSectionIds((prev) => {
                        const updated = new Set(prev);
                        if (next) updated.add(section.id);
                        else updated.delete(section.id);
                        return updated;
                      });
                    }}
                    headerActions={sectionAddButton(section.id)}
                    toggleDataAttr={`application-section-toggle-${section.id}`}
                    className={section.id === questionsMobileSectionId ? "" : "hidden lg:block"}
                  >
                    {renderSection(section.id)}
                  </PortalCollapsibleEditRow>
                );
              })}
              <button
                type="button"
                className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-card text-sm font-semibold text-primary lg:mt-2"
                data-attr="application-add-section"
                onClick={addQuestionSection}
              >
                + Add section
              </button>
            </div>
            {previewExtras}
          </StepColumn>
        ) : null}
        {stepId === "preview" ? (
          <StepColumn>
            <StepHeading title="Preview" />
            {previewBody}
            {previewExtras}
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
