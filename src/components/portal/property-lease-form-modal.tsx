"use client";

import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddWorkspace, WorkspacePreviewTitle, workspaceSaveState, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { Button } from "@/components/ui/button";
import {
  FloatingLabelField,
  MoneyInput,
  PanelSection,
  StepColumn,
  StepHeading,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ImportFileStrip } from "@/components/portal/listing-wizard-v2/import-upload-step";
import {
  PropertyFormStartFromFact,
  PropertyFormStartFromSelect,
  PropertyFormWizardCard,
  PropertyFormWizardRow,
  type PropertyFormStartFrom,
} from "@/components/portal/property-form-wizard-kit";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { FormPromoCodesRow } from "@/components/portal/form-promo-codes";
import { centsToMoneyText, moneyTextToCents } from "@/lib/form-template-fees";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import { applicationsOfLease, setApplicationsOfLease, uniqueFormLabel } from "@/lib/listing-inline-forms";
import { mappableApplicationTemplates } from "@/lib/application-lease-mapping";
import { normalizePropertyApplicationTemplateLabel } from "@/lib/property-application-template-sync";
import { isAddendumLeaseTemplate } from "@/lib/application-lease-mapping";
import { readPropertyApplicationTemplates, type PropertyApplicationTemplate } from "@/lib/property-application-templates";
import { deriveFormNameFromFileName } from "@/components/portal/pro-property-application-questions-panel";
import {
  LeaseConfigForm,
  LeaseDocumentModeField,
  readLeaseTemplateFile,
  type LeaseConfigDraft,
} from "@/components/portal/lease-config-form";
import { PropertyLeaseDocumentEditor } from "@/components/portal/property-lease-document-editor";
import { PropertyLeaseDocumentNotice, propertyLeaseNeedsAssistantReview } from "@/components/portal/property-lease-document-notice";
import { buildLeaseModalAssistantContext } from "@/lib/lease-assistant-context";
import { AGENT_PENDING_ACTIONS_EVENT } from "@/lib/axis-assistant/pending-actions-events";
import { resolveAllowedLeaseTerms, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  scopeLeaseDocumentHtmlForInlinePreview,
  stripDisclosureReviewFromLeaseHtml,
} from "@/lib/property-lease-document-display";
import { parseLeaseHtmlSections } from "@/lib/lease-html-sections";
import type { PropertyLeasePreviewHint } from "@/lib/property-lease-preview";
import { resolvePropertyLeaseEditHtml } from "@/lib/property-lease-edit";
import {
  PROPERTY_LEASE_TYPE_OPTIONS,
  createPropertyLeaseTemplate,
  readPropertyLeaseTemplates,
  makePropertyLeaseTemplateId,
  normalizeLeaseTemplateKind,
  propertyLeaseTypeLabel,
  templateAppearsToBeExecutedLease,
  updatePropertyLeaseTemplate,
  type PropertyLeaseTemplate,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";
import {
  applyPropertyLeaseDocumentMode,
  documentModeFromLease,
  leaseSourceFromDraft,
  PROPERTY_LEASE_DOCUMENT_MODE_OPTIONS,
  type PropertyLeaseDocumentMode,
  type PropertyLeaseSource,
} from "@/lib/property-lease-source";
import { parseUploadedLeasePdf, type ParseLeasePdfResult } from "@/lib/lease-template-parse.client";
import { summarizeImportIssues } from "@/lib/pdf-import/import-issue-summary";
import { changedSectionEntries, diffImportSections } from "@/lib/import-staging/section-diff";
import { extractLeaseSectionsFromHtml } from "@/lib/import-staging/lease-html-sections";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { track } from "@/lib/analytics/track-client";
import {
  allowedTermsAfterLeaseOptions,
  deriveLeaseKindFromStayTerms,
  LEASE_OPTION_TERM,
  leaseOptionFlags,
  leaseTermsAllowOptions,
  offeredStayTypeTerms,
  setLeaseOptionOnTemplates,
  stayTypeLabelForLeaseKindDisplay,
  type LeaseOptionKey,
} from "@/lib/property-form-stay-type-routing";

async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure import review is unavailable.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The lease-term choices an applicant can make, as "Applies to" boxes. */
const LEASE_ADD_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "long-term", label: "Long-term" },
  { value: "short-term", label: "Short-term" },
];

/** Steps are Name, Document, Preview; the import review box is on Document. */
const DOCUMENT_STEP_INDEX = 1;

/**
 * F013: the class the rendered lease document's own serif/underline look is
 * scoped under — see `scopeLeaseDocumentHtmlForInlinePreview`. Never applied
 * to any editor chrome element, only to the div the document HTML is
 * injected into.
 */
/** Select value standing for "no link" (a select option cannot carry null). */
const NO_LINK = "__none__";

/** One option of a long-term lease: a checkbox and its label, nothing under it. */
function LeaseOptionCheckbox({
  label,
  checked,
  dataAttr,
  onChange,
}: {
  label: string;
  checked: boolean;
  dataAttr: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex min-h-[52px] cursor-pointer items-center gap-3 border-b border-border/80 py-2.5 last:border-b-0">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-border text-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-attr={dataAttr}
      />
      <span className={WIZARD_LABEL_CLASS}>{label}</span>
    </label>
  );
}

export const LEASE_PREVIEW_DOCUMENT_SCOPE = "lease-document-preview-scope";

const LEASE_UPLOAD_ACCEPT = "application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function validateLeaseDraft(draft: LeaseConfigDraft, mode: PropertyLeaseDocumentMode): string | null {
  if (mode !== "upload") return null;
  return draft.leaseTemplateDocUrl?.trim()
    ? null
    : "Upload your lease PDF, or switch to a PropLane default.";
}

function draftFromTemplate(template: PropertyLeaseTemplate): LeaseConfigDraft {
  return {
    leaseConfigMode: template.leaseConfigMode,
    leaseCustomKind:
      template.leaseCustomKind === "document"
        ? "document"
        : template.leaseCustomKind === "builder"
          ? "builder"
          : "terms",
    customLeaseTerms: template.customLeaseTerms ?? "",
    leaseTemplateDocUrl: template.leaseTemplateDocUrl ?? null,
    leaseTemplateDocName: template.leaseTemplateDocName ?? "",
  };
}

/**
 * Single-screen add / edit lease — name, document mode, upload (when needed), and inline format editor.
 */
export function PropertyLeaseFormModal({
  open,
  mode,
  sub,
  template,
  templates,
  propertyHint,
  propertyId,
  bulk = false,
  initialStay,
  demoMode = false,
  canDelete = false,
  onClose,
  onSave,
  onDelete,
  onAssistantRefresh,
  showToast,
}: {
  open: boolean;
  mode: "add" | "edit";
  sub: ManagerListingSubmissionV1;
  template?: PropertyLeaseTemplate | null;
  templates?: PropertyLeaseTemplate[];
  propertyHint?: PropertyLeasePreviewHint;
  propertyId?: string | null;
  /** A bulk edit spans several properties, whose ids differ: no per-template link rows. */
  bulk?: boolean;
  /** A NEW lease opens as this stay's PropLane format (the open Long-term / Short-term tab). */
  initialStay?: "long_term" | "short_term";
  demoMode?: boolean;
  canDelete?: boolean;
  onClose: () => void;
  /**
   * `extra.applications`: the property's applications after this save. `extra.allowedLeaseTerms`:
   * the listing's allowed terms after "Allow custom dates" / "Allow month-to-month" changed.
   */
  onSave: (
    nextTemplates: PropertyLeaseTemplate[],
    extra?: {
      applications?: PropertyApplicationTemplate[];
      allowedLeaseTerms?: string[];
      /** Which checkboxes changed, so a bulk save can apply the same change to each property's own terms. */
      touchedLeaseOptions?: LeaseOptionKey[];
    },
  ) => boolean | Promise<boolean>;
  onDelete?: () => void;
  /** Reload listing submission after assistant confirms a lease edit. */
  onAssistantRefresh?: () => void;
  showToast: (message: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<PropertyLeaseTemplateKind>("long-term");
  const [documentMode, setDocumentMode] = useState<PropertyLeaseDocumentMode>("proplane_long_term");
  const [draft, setDraft] = useState<LeaseConfigDraft>(() => ({
    leaseConfigMode: "standard",
    leaseCustomKind: "terms",
    customLeaseTerms: "",
    leaseTemplateDocUrl: null,
    leaseTemplateDocName: "",
  }));
  const [error, setError] = useState<string | null>(null);
  /** Which applicant lease-term choices route to this lease ("Applies to"). */
  const [applicationLeaseTerms, setApplicationLeaseTerms] = useState<string[]>([]);
  const [linkedApplicationTemplateId, setLinkedApplicationTemplateId] = useState<string | null>(null);
  const [offered, setOffered] = useState(true);
  // This lease's own Lease fee (typed dollars; "" = none) and the applications that lead to it.
  const [leaseFeeText, setLeaseFeeText] = useState("");
  const [applicationIds, setApplicationIds] = useState<string[]>([]);
  const initialApplicationIdsRef = useRef<string[]>([]);
  // F-editor d/F015: another of this property's lease templates whose form is
  // the co-signer/guarantor addendum — see `PropertyLeaseTemplate.linkedGuarantorLeaseTemplateId`.
  const [linkedGuarantorTemplateId, setLinkedGuarantorTemplateId] = useState<string | null>(null);
  const [htmlOverride, setHtmlOverride] = useState("");
  const [templateUploading, setTemplateUploading] = useState(false);
  /** F013/F002: the file name shown on the Sections step's dashed "Start from a file" card while reading. */
  const [sectionsUploadFileName, setSectionsUploadFileName] = useState<string | null>(null);
  const [parsingLease, setParsingLease] = useState(false);
  const [importSource, setImportSource] = useState<
    Pick<ParseLeasePdfResult, "sourceSha256" | "sourceIssues" | "coverage" | "sectionCount"> | null
  >(null);
  const unreadableSourcePage = Boolean(importSource?.sourceIssues.some((issue) => issue.code === "unreadable_page"));
  const importIssueSummary = useMemo(
    () => summarizeImportIssues(importSource?.sourceIssues ?? []),
    [importSource],
  );
  const [importReviewError, setImportReviewError] = useState<string | null>(null);
  // F016: a freshly parsed lease upload, held here until the manager
  // explicitly applies it. Nothing above (`draft.leaseTemplateDocUrl`,
  // `htmlOverride`, `importSource`) changes until then, so picking a new file
  // while editing an already-saved lease never silently overwrites it.
  const [pendingLeaseImport, setPendingLeaseImport] = useState<{
    docUrl: string;
    fileName: string;
    html: string;
    sections: Array<{ title: string; body: string }>;
    inferredKind: PropertyLeaseTemplateKind;
    sourceSha256: string;
    sourceIssues: Array<{ pageNumber: number | null; code: string; message: string }>;
    coverage: { extractedCharacters: number; representedCharacters: number; complete: boolean };
  } | null>(null);
  const [pendingLeaseImportCompareOpen, setPendingLeaseImportCompareOpen] = useState(false);
  const [mobileTemplateTab, setMobileTemplateTab] = useState<"original" | "converted">("converted");
  const [saveReviewOpen, setSaveReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  // F007: a brand-new ("add" mode) lease has no id until the footer commit
  // creates it — generated once per open and reused as the created template's
  // real id at commit, exactly like the application editor's `addModeTemplateId`.
  const [addModeLeaseTemplateId, setAddModeLeaseTemplateId] = useState<string | null>(null);
  const [startFrom, setStartFrom] = useState<PropertyFormStartFrom>("proplane");
  const [copyFromLeaseId, setCopyFromLeaseId] = useState<string | null>(null);
  const [leaseAddType, setLeaseAddType] = useState("long-term");
  const [routingLeaseTemplates, setRoutingLeaseTemplates] = useState<PropertyLeaseTemplate[]>([]);
  const [routingApplicationTemplates, setRoutingApplicationTemplates] = useState<PropertyApplicationTemplate[]>([]);
  const replaceLeaseFileRef = useRef<HTMLInputElement>(null);

  // F013: inline duplicate-name validation — another lease already saved on
  // this property with the same (trimmed, case-insensitive) name.
  // The name a lease opens with is made unique, so the error shows only once the manager has typed a
  // name (or tried to save one) that another lease already uses.
  const [nameEdited, setNameEdited] = useState(false);
  const duplicateLeaseNameClash = useMemo(() => {
    const trimmed = label.trim().toLowerCase();
    if (!trimmed || !templates) return null;
    const clashes = templates.some(
      (candidate) => candidate.id !== template?.id && candidate.label.trim().toLowerCase() === trimmed,
    );
    return clashes ? `A lease named "${label.trim()}" already exists on this property.` : null;
  }, [label, templates, template?.id]);
  const duplicateLeaseNameError = nameEdited ? duplicateLeaseNameClash : null;

  const source = leaseSourceFromDraft(draft);
  const typeMeta = useMemo(
    () => PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === kind),
    [kind],
  );
  const documentModeMeta = useMemo(
    () => PROPERTY_LEASE_DOCUMENT_MODE_OPTIONS.find((o) => o.id === documentMode),
    [documentMode],
  );

  const copyLeaseOptions = useMemo(
    () => (templates ?? []).filter((row) => row.id !== template?.id).map((row) => ({ value: row.id, label: row.label })),
    [templates, template?.id],
  );

  const startFromFactLabel = useMemo(() => {
    if (documentMode === "upload") {
      return draft.leaseTemplateDocName?.trim() ? `${draft.leaseTemplateDocName.trim()} · uploaded PDF` : "Uploaded PDF";
    }
    if (source === "custom_builder") return "PropLane custom builder";
    if (source === "custom_comments") return "PropLane custom clauses";
    return "PropLane standard";
  }, [documentMode, draft.leaseTemplateDocName, source]);

  const previewSub = useMemo(
    (): ManagerListingSubmissionV1 => ({
      ...sub,
      ...draft,
    }),
    [sub, draft],
  );

  const templateDraft = useMemo(
    () => ({
      leaseConfigMode: draft.leaseConfigMode ?? "standard",
      leaseCustomKind:
        draft.leaseCustomKind === "document"
          ? ("document" as const)
          : draft.leaseCustomKind === "builder"
            ? ("builder" as const)
            : ("terms" as const),
      customLeaseTerms: draft.customLeaseTerms ?? "",
      leaseTemplateDocUrl: draft.leaseTemplateDocUrl ?? null,
      leaseTemplateDocName: draft.leaseTemplateDocName ?? "",
      leaseTemplateHtmlOverride: "",
    }),
    [draft],
  );

  const baselineHtml = useMemo(
    () =>
      resolvePropertyLeaseEditHtml({
        sub: previewSub,
        draft: templateDraft,
        source,
        templateKind: kind,
        hint: propertyHint,
        demo: demoMode,
      }),
    [previewSub, templateDraft, source, kind, propertyHint, demoMode],
  );

  const editorHtml = htmlOverride.trim() || baselineHtml;
  const displayHtml = useMemo(() => stripDisclosureReviewFromLeaseHtml(editorHtml), [editorHtml]);
  const noticeHtml = editorHtml;
  const showLeaseEditor = documentMode !== "upload" || Boolean(htmlOverride.trim());

  useEffect(() => {
    if (!open) return;
    setError(null);
    setNameEdited(false);
    setStepIdx(0);
    setRoutingLeaseTemplates(
      (templates ?? []).map((row) =>
        mode === "edit" && template?.id === row.id ? { ...row, ...template } : row,
      ),
    );
    setRoutingApplicationTemplates(readPropertyApplicationTemplates(sub));
    if (mode === "edit" && template) {
      const templateDraftFields = draftFromTemplate(template);
      const templateSource = leaseSourceFromDraft(templateDraftFields);
      const templateKind = normalizeLeaseTemplateKind(template.kind);
      setLabel(template.label);
      setKind(templateKind);
      setApplicationLeaseTerms([...(template.applicationLeaseTerms ?? [])]);
      setLinkedApplicationTemplateId(template.linkedApplicationTemplateId ?? null);
      setOffered(template.offered !== false);
      setLeaseFeeText(typeof template.leaseFeeCents === "number" ? centsToMoneyText(template.leaseFeeCents) : "");
      const tied = applicationsOfLease(
        { applications: readPropertyApplicationTemplates(sub), leases: readPropertyLeaseTemplates(sub) },
        template.id,
      ).map((application) => application.id);
      initialApplicationIdsRef.current = tied;
      setApplicationIds(tied);
      setDocumentMode(documentModeFromLease(templateSource, templateKind));
      setDraft(templateDraftFields);
      setHtmlOverride(template.leaseTemplateHtmlOverride?.trim() ?? "");
      setImportSource(template.leaseTemplateImportReview ? {
        sourceSha256: template.leaseTemplateImportReview.sourceSha256,
        sourceIssues: template.leaseTemplateImportReview.issueCodes.map((code) => ({ pageNumber: null, code, message: "Previously reviewed source issue." })),
        coverage: {
          extractedCharacters: template.leaseTemplateImportReview.extractedCharacters,
          representedCharacters: template.leaseTemplateImportReview.representedCharacters,
          complete: template.leaseTemplateImportReview.issueCodes.length === 0,
        },
        sectionCount: parseLeaseHtmlSections(template.leaseTemplateHtmlOverride ?? "").filter((s) => s.id !== "lease-document-header").length,
      } : null);
      setLinkedGuarantorTemplateId(template.linkedGuarantorLeaseTemplateId ?? null);
      setPendingLeaseImport(null);
      setPendingLeaseImportCompareOpen(false);
      setAddModeLeaseTemplateId(null);
      setStartFrom(documentModeFromLease(templateSource, templateKind) === "upload" ? "upload" : "proplane");
      setCopyFromLeaseId(null);
      setLeaseAddType(templateKind === "short-term" ? "short-term" : "long-term");
      return;
    }
    setAddModeLeaseTemplateId(makePropertyLeaseTemplateId());
    setStartFrom("proplane");
    setCopyFromLeaseId(null);
    const addKind = initialStay === "short_term" ? "short-term" : "long-term";
    const addMode = initialStay === "short_term" ? "proplane_short_term" : "proplane_long_term";
    setLeaseAddType(addKind);
    // A default name another lease already uses opens as "<name> 2", so the duplicate error never greets a new lease.
    setNameEdited(false);
    setLabel(uniqueFormLabel((templates ?? []).map((row) => row.label), PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === addKind)!.defaultLabel));
    setLinkedApplicationTemplateId(null);
    setOffered(true);
    setLeaseFeeText("");
    initialApplicationIdsRef.current = [];
    setApplicationIds([]);
    setKind(addKind);
    setDocumentMode(addMode);
    const applied = applyPropertyLeaseDocumentMode(addMode);
    setDraft((d) => ({ ...d, ...applied.draftFields }));
    setHtmlOverride("");
    setImportSource(null);
    setLinkedGuarantorTemplateId(null);
    setPendingLeaseImport(null);
    setPendingLeaseImportCompareOpen(false);
  }, [open, mode, template, templates, sub, initialStay]);

  useEffect(() => {
    if (!open || mode !== "edit" || !template?.id) return;
    const row = routingLeaseTemplates.find((entry) => entry.id === template.id);
    if (!row) return;
    setApplicationLeaseTerms([...(row.applicationLeaseTerms ?? [])]);
    setKind(deriveLeaseKindFromStayTerms(row.applicationLeaseTerms ?? []));
  }, [open, mode, routingLeaseTemplates, template?.id]);

  const templatesRef = useRef(templates);
  useEffect(() => {
    templatesRef.current = templates;
  }, [templates]);

  useEffect(() => {
    if (!open || mode === "edit") return;
    const defaultLabel =
      documentMode === "proplane_short_term"
        ? PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === "short-term")?.defaultLabel
        : PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === "long-term")?.defaultLabel;
    if (defaultLabel) setLabel(uniqueFormLabel((templatesRef.current ?? []).map((row) => row.label), defaultLabel));
  }, [documentMode, open, mode]);

  const handleDocumentModeChange = (next: PropertyLeaseDocumentMode) => {
    setError(null);
    setHtmlOverride("");
    setImportSource(null);
    setImportReviewError(null);
    setPendingLeaseImport(null);
    setPendingLeaseImportCompareOpen(false);
    const applied = applyPropertyLeaseDocumentMode(next);
    setDocumentMode(next);
    setKind(applied.kind);
    setDraft((d) => ({ ...d, ...applied.draftFields }));
  };

  const initialOptionFlags = useMemo(
    () => leaseOptionFlags(template?.applicationLeaseTerms ?? []),
    [template],
  );
  const optionFlags = leaseOptionFlags(applicationLeaseTerms);
  const showLeaseOptions =
    mode === "edit"
      ? template?.kind !== "short-term" && leaseTermsAllowOptions(applicationLeaseTerms)
      : leaseAddType !== "short-term";
  const toggleLeaseOption = (option: LeaseOptionKey, on: boolean) => {
    setError(null);
    if (mode === "edit" && template?.id) {
      // The terms the lease routes (applicationLeaseTerms) are the stored form of the checkbox.
      setRoutingLeaseTemplates((current) => setLeaseOptionOnTemplates(current, template.id, option, on));
      return;
    }
    const term = LEASE_OPTION_TERM[option];
    setApplicationLeaseTerms((current) =>
      on ? (current.includes(term) ? current : [...current, term]) : current.filter((t) => t !== term),
    );
  };

  const applyLeaseAddType = useCallback(
    (nextType: string) => {
      setLeaseAddType(nextType);
      if (nextType === "short-term") {
        handleDocumentModeChange("proplane_short_term");
        setApplicationLeaseTerms([]);
        return;
      }
      handleDocumentModeChange("proplane_long_term");
    },
    [],
  );

  useEffect(() => {
    if (!open || mode !== "add" || startFrom !== "copy" || !copyFromLeaseId) return;
    const src = templates?.find((row) => row.id === copyFromLeaseId);
    if (!src) return;
    const srcDraft = draftFromTemplate(src);
    const srcSource = leaseSourceFromDraft(srcDraft);
    const srcKind = normalizeLeaseTemplateKind(src.kind);
    setLabel(uniqueFormLabel((templates ?? []).map((row) => row.label), `${src.label.trim()} copy`));
    setKind(srcKind);
    // A copy never inherits "Allow custom dates" / "Allow month-to-month": a term routes to one lease.
    setApplicationLeaseTerms([]);
    setLinkedApplicationTemplateId(src.linkedApplicationTemplateId ?? null);
    setDocumentMode(documentModeFromLease(srcSource, srcKind));
    setDraft(srcDraft);
    setHtmlOverride(src.leaseTemplateHtmlOverride?.trim() ?? "");
  }, [copyFromLeaseId, mode, open, startFrom, templates]);

  const leaseTemplateError = error && documentMode === "upload" ? error : null;

  // F016: parses the uploaded PDF and STAGES the result — `draft`,
  // `htmlOverride`, and `importSource` are untouched until
  // `applyPendingLeaseImport` runs. Picking a new file while editing an
  // ALREADY-SAVED lease must never silently replace what is on screen.
  const onPickLeaseTemplateDoc = (file: File | null) => {
    if (templateAppearsToBeExecutedLease(template)) {
      setError("This lease has already been signed and cannot be edited here.");
      return;
    }
    readLeaseTemplateFile(
      file,
      (dataUrl, fileName) => {
        setError(null);
        if (dataUrl.startsWith("data:")) {
          // Demo mode has no server session to parse against — nothing was
          // parsed, so there is nothing to stage; this upload becomes the
          // document (and is parsed) only after save, same as before.
          setHtmlOverride("");
          setImportSource(null);
          setImportReviewError(null);
          setPendingLeaseImport(null);
          setPendingLeaseImportCompareOpen(false);
          setDraft((d) => ({ ...d, leaseTemplateDocUrl: dataUrl, leaseTemplateDocName: fileName }));
          showToast("Lease uploaded. Parsing runs after save in demo mode.");
          return;
        }
        setPendingLeaseImport(null);
        setPendingLeaseImportCompareOpen(false);
        setParsingLease(true);
        track("lease_import_started", { import_kind: "property_template" });
        void parseUploadedLeasePdf({ url: dataUrl, fileName, kind })
          .then((result) => {
            setPendingLeaseImport({
              docUrl: dataUrl,
              fileName,
              html: result.html,
              sections: result.sections,
              inferredKind: result.inferredKind,
              sourceSha256: result.sourceSha256,
              sourceIssues: result.sourceIssues,
              coverage: result.coverage,
            });
            showToast(`Found ${result.sections.length} section${result.sections.length === 1 ? "" : "s"}. Review before applying.`);
          })
          .catch((err) => {
            track("lease_import_failed", { import_kind: "property_template", reason_code: "parse_failed" });
            console.error("property-lease-form-modal: parse failed", err);
            showToast(err instanceof Error ? err.message : "Could not parse that lease PDF.");
          })
          .finally(() => setParsingLease(false));
      },
      showToast,
      setTemplateUploading,
    );
  };

  // The pop-up's one "Start from a file" card (first step, Add mode). Same door as the Lease step's
  // strip: jump to the step that hosts the strip + staged-import card so the reading state and the
  // "Replace what you typed?" confirm are visible, then run the one existing handler.
  const onPickLeaseFromHeader = (file: File) => {
    setStepIdx(0);
    setStartFrom("upload");
    setSectionsUploadFileName(file.name);
    if (documentMode !== "upload") handleDocumentModeChange("upload");
    if (!label.trim()) setLabel(uniqueFormLabel((templates ?? []).map((row) => row.label), deriveFormNameFromFileName(file.name)));
    onPickLeaseTemplateDoc(file);
  };

  // F016: writes a staged import into the lease being edited — the same
  // state the parse success handler used to set immediately. This is the
  // ONLY place that happens; picking a file never does it on its own.
  const applyPendingLeaseImport = () => {
    if (!pendingLeaseImport) return;
    if (templateAppearsToBeExecutedLease(template)) {
      setError("This lease has already been signed and cannot be edited here.");
      setPendingLeaseImport(null);
      setPendingLeaseImportCompareOpen(false);
      return;
    }
    const p = pendingLeaseImport;
    setError(null);
    setImportSource({
      sourceSha256: p.sourceSha256,
      sourceIssues: p.sourceIssues,
      coverage: p.coverage,
      sectionCount: p.sections.length,
    });
    setImportReviewError(null);
    setDraft((d) => ({ ...d, leaseTemplateDocUrl: p.docUrl, leaseTemplateDocName: p.fileName }));
    if (!p.sourceIssues.some((issue) => issue.code === "unreadable_page")) setHtmlOverride(p.html);
    else setHtmlOverride("");
    if (mode === "add") setKind(p.inferredKind);
    setPendingLeaseImport(null);
    setPendingLeaseImportCompareOpen(false);
    showToast(
      p.sourceIssues.length
        ? "Applied. Check it against the original PDF before saving."
        : `Applied ${p.sections.length} section${p.sections.length === 1 ? "" : "s"}.`,
    );
  };

  // F016: drops the staged import. The lease is left exactly as it was —
  // nothing that `applyPendingLeaseImport` would have written is touched.
  const discardPendingLeaseImport = () => {
    setPendingLeaseImport(null);
    setPendingLeaseImportCompareOpen(false);
  };

  // F016: the staged import's sections, diffed against the CURRENT document
  // (best-effort recovered from its rendered HTML — see
  // `extractLeaseSectionsFromHtml`'s own doc comment).
  const pendingLeaseImportDiff = useMemo(
    () =>
      pendingLeaseImport
        ? diffImportSections(extractLeaseSectionsFromHtml(editorHtml), pendingLeaseImport.sections)
        : null,
    [pendingLeaseImport, editorHtml],
  );

  /** Why the converted document can't be saved yet, or null. */
  const importReviewBlocker = (resolvedHtml: string | null | undefined): string | null => {
    if (documentMode !== "upload" || !resolvedHtml || !importSource) return null;
    // Saving the template IS the confirmation: no box to tick.
    return null;
  };

  const resolveHtmlOverrideToSave = (): string => {
    const trimmed = editorHtml.trim();
    if (!trimmed) return "";
    if (trimmed === baselineHtml.trim()) return "";
    return trimmed;
  };

  // First-step link row. An addendum maps to nothing and has no addendum of its own.
  const thisIsAddendum = Boolean(template && isAddendumLeaseTemplate(template));
  const linkRowsAvailable = !bulk && !thisIsAddendum;
  const addendumRowOptions = (templates ?? [])
    .filter((row) => row.id !== template?.id && (isAddendumLeaseTemplate(row) || row.id === linkedGuarantorTemplateId))
    .map((row) => ({ value: row.id, label: row.label }));
  const showAddendumRow = linkRowsAvailable && (addendumRowOptions.length > 0 || linkedGuarantorTemplateId !== null);

  const dismiss = () => {
    setSaveReviewOpen(false);
    onClose();
  };

  const commitSave = async () => {
    if (duplicateLeaseNameClash) {
      setNameEdited(true);
      setError(duplicateLeaseNameClash);
      return;
    }
    const validationError = validateLeaseDraft(draft, documentMode);
    if (validationError) {
      setError(validationError);
      return;
    }

    const resolvedHtml = resolveHtmlOverrideToSave();
    // Backstop for "save anyway", which skips `save`.
    const reviewBlocker = importReviewBlocker(resolvedHtml);
    if (reviewBlocker) {
      setImportReviewError(reviewBlocker);
      setStepIdx(DOCUMENT_STEP_INDEX);
      return;
    }

    const trimmedLabel = label.trim() || typeMeta?.defaultLabel || "Lease";
    let leaseTemplateImportReview = template?.leaseTemplateImportReview;
    if (documentMode === "upload" && resolvedHtml && importSource) {
      try {
        leaseTemplateImportReview = {
          sourceSha256: importSource.sourceSha256,
          convertedHtmlSha256: await sha256Text(resolvedHtml),
          reviewedAtIso: new Date().toISOString(),
          templateVersion: `${template?.id ?? "new"}@${(template?.updatedAt ?? new Date().toISOString())}`,
          issueCodes: importSource.sourceIssues.map((issue) => issue.code),
          resolvedIssueCodes: unreadableSourcePage ? ["unreadable_page"] : [],
          extractedCharacters: importSource.coverage.extractedCharacters,
          representedCharacters: importSource.coverage.representedCharacters,
        };
      } catch (err) {
        setImportReviewError(err instanceof Error ? err.message : "Could not verify the converted lease.");
        return;
      }
    }
    const leaseFields = {
      leaseConfigMode: draft.leaseConfigMode ?? "standard",
      leaseCustomKind:
        draft.leaseCustomKind === "document"
          ? ("document" as const)
          : draft.leaseCustomKind === "builder"
            ? ("builder" as const)
            : ("terms" as const),
      customLeaseTerms: draft.customLeaseTerms ?? "",
      leaseTemplateDocUrl: draft.leaseTemplateDocUrl ?? null,
      leaseTemplateDocName: draft.leaseTemplateDocName ?? "",
      leaseTemplateHtmlOverride: resolveHtmlOverrideToSave(),
      leaseTemplateImportReview: resolvedHtml ? leaseTemplateImportReview : undefined,
    };

    const savingLeaseId = mode === "add" ? (addModeLeaseTemplateId ?? makePropertyLeaseTemplateId()) : template?.id ?? "";
    const nextApplicationLink = linkedApplicationTemplateId;
    // The property's applications ride along; so do the listing's allowed terms when an option changed.
    const leaseFeeCents = moneyTextToCents(leaseFeeText);
    const saveExtra: {
      applications: PropertyApplicationTemplate[];
      allowedLeaseTerms?: string[];
      touchedLeaseOptions?: LeaseOptionKey[];
    } = {
      applications: routingApplicationTemplates,
    };
    // Which applications lead to this lease: an application leads to ONE lease, so a newly picked one moves here.
    const applicationsChanged =
      applicationIds.length !== initialApplicationIdsRef.current.length ||
      applicationIds.some((id) => !initialApplicationIdsRef.current.includes(id));
    const withApplicationLinks = (finalTemplates: PropertyLeaseTemplate[], leaseId: string) => {
      if (!applicationsChanged) return;
      saveExtra.applications = setApplicationsOfLease(
        { applications: routingApplicationTemplates, leases: finalTemplates },
        leaseId,
        applicationIds,
      );
    };
    const touchedOptions: LeaseOptionKey[] =
      mode === "add"
        ? (["custom", "monthToMonth"] as const).filter((key) => optionFlags[key])
        : (["custom", "monthToMonth"] as const).filter((key) => optionFlags[key] !== initialOptionFlags[key]);
    const withAllowedTerms = (finalTemplates: PropertyLeaseTemplate[]) => {
      if (touchedOptions.length > 0) {
        saveExtra.touchedLeaseOptions = [...touchedOptions];
        saveExtra.allowedLeaseTerms = allowedTermsAfterLeaseOptions(
          resolveAllowedLeaseTerms(sub),
          finalTemplates,
          touchedOptions,
        );
      }
      return finalTemplates;
    };

    setSaving(true);
    try {
      if (mode === "add") {
        const created = {
          ...createPropertyLeaseTemplate({
            kind,
            label: trimmedLabel,
            source: leaseSourceFromDraft(leaseFields),
            customLeaseTerms: leaseFields.customLeaseTerms,
            leaseTemplateDocUrl: leaseFields.leaseTemplateDocUrl,
            leaseTemplateDocName: leaseFields.leaseTemplateDocName,
          }),
          // F007: reuse the SAME id the Setup step's Default toggle already
          // read/wrote against before this commit — otherwise a manager who
          // set the default during "add" would have it point at an id no
          // template ever ends up with.
          id: savingLeaseId,
          leaseTemplateHtmlOverride: leaseFields.leaseTemplateHtmlOverride,
          leaseTemplateImportReview: leaseFields.leaseTemplateImportReview,
          linkedGuarantorLeaseTemplateId: linkedGuarantorTemplateId,
          linkedApplicationTemplateId: nextApplicationLink,
          offered,
          leaseFeeCents,
        };
        // "Allow custom dates" / "Allow month-to-month" on a new long-term lease: the same routed terms.
        const createdWithOptions = touchedOptions.reduce(
          (list, key) => setLeaseOptionOnTemplates(list, created.id, key, true),
          [...routingLeaseTemplates, created] as PropertyLeaseTemplate[],
        );
        const next = withAllowedTerms(createdWithOptions);
        withApplicationLinks(next, created.id);
        if (!(await Promise.resolve(onSave(next, saveExtra)))) return;
        if (leaseFields.leaseTemplateImportReview) {
          track("lease_import_reviewed", { template_id: created.id, import_kind: "property_template", artifact_mode: "converted" });
        }
        showToast("Lease added.");
        dismiss();
        return;
      }

      if (!template || !templates) {
        showToast("Could not save lease.");
        return;
      }
      if (applicationLeaseTerms.length === 0) {
        showToast("A lease must apply to at least one lease type.");
        return;
      }

      const resolvedKind = deriveLeaseKindFromStayTerms(applicationLeaseTerms);
      const next = withAllowedTerms(
        updatePropertyLeaseTemplate(routingLeaseTemplates, template.id, {
          label: trimmedLabel,
          kind: resolvedKind,
          applicationLeaseTerms,
          linkedGuarantorLeaseTemplateId: linkedGuarantorTemplateId,
          linkedApplicationTemplateId: nextApplicationLink,
          offered,
          leaseFeeCents,
          ...leaseFields,
        }),
      );
      withApplicationLinks(next, template.id);
      if (!(await Promise.resolve(onSave(next, saveExtra)))) return;
      if (leaseFields.leaseTemplateImportReview) {
        track("lease_import_reviewed", { template_id: template.id, import_kind: "property_template", artifact_mode: "converted" });
      }
      showToast("Lease saved.");
      dismiss();
    } finally {
      setSaving(false);
    }
  };

  // Both blockers render on the Document step, so Save from Preview returns
  // there; otherwise the click would do nothing visible.
  const save = () => {
    const reviewBlocker = importReviewBlocker(resolveHtmlOverrideToSave());
    if (reviewBlocker) {
      setImportReviewError(reviewBlocker);
      setStepIdx(DOCUMENT_STEP_INDEX);
      return;
    }
    if (showLeaseEditor && propertyLeaseNeedsAssistantReview(noticeHtml)) {
      setSaveReviewOpen(true);
      setStepIdx(DOCUMENT_STEP_INDEX);
      return;
    }
    void commitSave();
  };

  const confirm = useConfirm();

  const handleDelete = async () => {
    if (!canDelete || !onDelete) return;
    if (!(await confirm({ description: "Delete this lease?" }))) return;
    onDelete();
    dismiss();
  };

  const assistantContext = useMemo(
    () =>
      buildLeaseModalAssistantContext({
        propertyId,
        currentSource: source,
        templateKind: kind === "short-term" || kind === "long-term" ? kind : "long-term",
        propertyLabel: propertyHint?.buildingName ?? label,
      }),
    [propertyId, source, kind, propertyHint?.buildingName, label],
  );

  const refreshFromAssistant = useCallback(() => {
    onAssistantRefresh?.();
  }, [onAssistantRefresh]);

  useEffect(() => {
    if (!open || !onAssistantRefresh) return;
    const onActions = () => refreshFromAssistant();
    window.addEventListener(AGENT_PENDING_ACTIONS_EVENT, onActions);
    return () => window.removeEventListener(AGENT_PENDING_ACTIONS_EVENT, onActions);
  }, [open, onAssistantRefresh, refreshFromAssistant]);

  useEffect(() => {
    if (!open || !template?.leaseTemplateHtmlOverride?.trim()) return;
    setHtmlOverride(template.leaseTemplateHtmlOverride.trim());
  }, [open, template?.id, template?.updatedAt, template?.leaseTemplateHtmlOverride]);

  const workspaceSteps: AddWorkspaceStep[] = [
    {
      id: "name",
      label: "Lease",
      incomplete: !label.trim() || (mode === "edit" && applicationLeaseTerms.length === 0),
      summary: label.trim() || "Name this lease",
    },
    {
      // Lease → Document. Workspace-wide choices live in Settings → Applications &
      // leases; property switches in the Lease tab's settings gear. The internal id
      // stays stable for the import guards.
      id: "document",
      label: "Document",
      incomplete: documentMode === "upload" && !draft.leaseTemplateDocUrl,
      summary: documentModeMeta?.label ?? "Lease document",
    },
    // "Preview" is no longer a separate rail step (P005: 3 steps, not 4) —
    // `htmlPreview` was already passed as `sidePanel` below and rendered on
    // EVERY step, so dropping this entry loses no capability, it just stops
    // duplicating that same content as a 4th step. `lastLabel`/`onFinish`
    // below are step-id-agnostic, so Save now naturally lands on Setup.
  ];
  const current = Math.min(stepIdx, workspaceSteps.length - 1);
  const stepId = workspaceSteps[current]!.id;
  const dirty = Boolean(label.trim() || htmlOverride.trim() || draft.leaseTemplateDocUrl);

  const htmlPreview = (
    <section>
    <WorkspacePreviewTitle>Lease preview</WorkspacePreviewTitle>
    <div className="max-h-[70vh] overflow-auto rounded-2xl border border-border bg-card p-3 text-[13px] leading-relaxed text-foreground" data-attr="property-lease-html-preview">
      {displayHtml.trim() ? (
        <div
          className={LEASE_PREVIEW_DOCUMENT_SCOPE}
          dangerouslySetInnerHTML={{
            __html: scopeLeaseDocumentHtmlForInlinePreview(displayHtml, LEASE_PREVIEW_DOCUMENT_SCOPE),
          }}
        />
      ) : (
        <p>No lease document yet.</p>
      )}
    </div>
    </section>
  );

  // F016: a freshly parsed lease upload waits here — nothing above or below
  // has changed yet. "Apply changes from the file" is the only thing that
  // writes it in; "Discard" drops it and leaves the lease exactly as it was.
  const pendingLeaseImportCard = pendingLeaseImport && pendingLeaseImportDiff ? (
    <div className="mb-4 rounded-2xl border border-primary/40 bg-primary/[0.04] p-3.5" data-attr="property-lease-pending-import">
      <p className="text-[13.5px] font-bold text-foreground" data-attr="property-lease-pending-import-summary">
        {pendingLeaseImportDiff.totalIncoming} section{pendingLeaseImportDiff.totalIncoming === 1 ? "" : "s"} found ·{" "}
        {pendingLeaseImportDiff.changedCount === 0 ? "up to date" : `${pendingLeaseImportDiff.changedCount} changed`}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          onClick={() => setPendingLeaseImportCompareOpen((v) => !v)}
          data-attr="property-lease-pending-import-compare"
        >
          {pendingLeaseImportCompareOpen ? "Hide compare" : "Compare"}
        </Button>
        <Button type="button" variant="primary" className="rounded-full" onClick={applyPendingLeaseImport} data-attr="property-lease-pending-import-apply">
          Apply changes from the file
        </Button>
        <Button type="button" variant="outline" className="rounded-full" onClick={discardPendingLeaseImport} data-attr="property-lease-pending-import-discard">
          Discard
        </Button>
      </div>
      {pendingLeaseImportCompareOpen ? (
        <ul className="mt-3 space-y-2" data-attr="property-lease-pending-import-changed-sections">
          {changedSectionEntries(pendingLeaseImportDiff).length === 0 ? (
            <li className="text-[13px] text-muted">No sections changed.</li>
          ) : (
            changedSectionEntries(pendingLeaseImportDiff).map((entry) => (
              <li key={entry.key} className="rounded-xl border border-border bg-card p-2.5 text-[13px]" data-attr="property-lease-pending-import-changed-section">
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
  ) : null;

  const workspaceDraft = useWorkspaceDraft({
    scope: `property-lease:${propertyId ?? sub.address ?? "property"}:${mode}:${template?.id ?? "new"}`,
    open, value: { label, kind, documentMode, draft, applicationLeaseTerms, linkedGuarantorTemplateId, linkedApplicationTemplateId, htmlOverride, sectionsUploadFileName, importSource, pendingLeaseImport, stepIdx, addModeLeaseTemplateId },
    restore: (saved) => { setLabel(saved.label); setKind(saved.kind); setDocumentMode(saved.documentMode); setDraft(saved.draft); setApplicationLeaseTerms(saved.applicationLeaseTerms); setLinkedGuarantorTemplateId(saved.linkedGuarantorTemplateId); setLinkedApplicationTemplateId(saved.linkedApplicationTemplateId ?? null); setHtmlOverride(saved.htmlOverride); setSectionsUploadFileName(saved.sectionsUploadFileName); setImportSource(saved.importSource); setPendingLeaseImport(saved.pendingLeaseImport); setStepIdx(saved.stepIdx); setAddModeLeaseTemplateId(saved.addModeLeaseTemplateId); },
  });

  if (!open) return null;

  return (
    <AddWorkspace
      title={mode === "add" ? "New lease" : "Edit lease"}
      steps={workspaceSteps}
      current={current}
      onJump={setStepIdx}
      onClose={() => {
        if (mode === "add") {
          workspaceDraft.preserve();
          if (dirty) showToast("Draft saved");
        }
        dismiss();
      }}
      discardBody={
        mode === "edit" ? "Discard unsaved changes to this lease?" : "Discard this lease?"
      }
      keepsDraft={mode === "add"}
      onDiscardDraft={mode === "add" ? workspaceDraft.clear : undefined}
      dirty={dirty}
      discardTitle="Discard this lease?"
      assistantContext={assistantContext}
      assistantScopeKey="Lease modal"
      headerUpload={mode === "add" ? { accept: "application/pdf,.pdf", chips: [".pdf", "up to 8 MB"], onPick: onPickLeaseFromHeader, disabled: templateUploading || parsingLease || saving, dataAttr: "property-lease-header-upload", label: "Upload lease" } : undefined}
      sidePanel={htmlPreview}
      lastLabel={mode === "add" ? "Create lease" : "Save"}
      lastDisabled={templateUploading || parsingLease || saving || Boolean(duplicateLeaseNameError) || Boolean(pendingLeaseImport)}
      onBeforeNext={() => {
        if (stepId === "name" && !label.trim()) {
          setError("Enter a name for this lease.");
          return false;
        }
        if (stepId === "name" && duplicateLeaseNameClash) {
          setNameEdited(true);
          return false;
        }
        if (stepId === "name" && mode === "edit" && applicationLeaseTerms.length === 0) {
          setError("A lease must apply to at least one lease type.");
          return false;
        }
        if (stepId === "document") {
          const validationError = validateLeaseDraft(draft, documentMode);
          if (validationError) {
            setError(validationError);
            return false;
          }
          const reviewBlocker = importReviewBlocker(resolveHtmlOverrideToSave());
          if (reviewBlocker) {
            setImportReviewError(reviewBlocker);
            return false;
          }
        }
        setError(null);
        return true;
      }}
      busy={templateUploading || parsingLease || saving}
      onFinish={save}
      saveState={parsingLease ? "Parsing…" : templateUploading ? "Uploading…" : workspaceSaveState({ busy: saving, dirty, isNew: mode === "add" })}
      dataAttrPrefix="property-lease"
      numberedSteps={false}
      hideFooterStepCount
      finishDataAttr={mode === "add" ? "property-lease-add-save" : "property-lease-edit-save"}
      footerNote={error ? <span className="text-sm text-rose-600">{error}</span> : null}
      onDelete={mode === "edit" && canDelete && onDelete ? () => void handleDelete() : undefined}
      deleteDataAttr="property-lease-delete"
    >
      {stepId === "name" ? (
        <StepColumn>
          <StepHeading title="Lease" />
          <PropertyFormWizardCard dataAttr="property-lease-step-one-card">
            {mode === "edit" ? (
              <PropertyFormWizardRow label="Type of lease">
                <span className="text-sm font-semibold text-foreground" data-attr="property-lease-type-fact">
                  {stayTypeLabelForLeaseKindDisplay(applicationLeaseTerms, offeredStayTypeTerms(sub))}
                </span>
              </PropertyFormWizardRow>
            ) : (
              <PropertyFormWizardRow label="Type of lease">
                <FieldSingleSelect
                  hideLabel
                  label="Type of lease"
                  labelClassName={WIZARD_LABEL_CLASS}
                  variant="cell"
                  className="min-w-[200px] max-w-[280px]"
                  value={leaseAddType}
                  dataAttr="property-lease-type"
                  options={LEASE_ADD_TYPE_OPTIONS}
                  onChange={(next) => {
                    if (startFrom === "proplane") applyLeaseAddType(next);
                    else setLeaseAddType(next);
                  }}
                />
              </PropertyFormWizardRow>
            )}
            {showLeaseOptions ? (
              <>
                <LeaseOptionCheckbox
                  label="Allow custom dates"
                  checked={optionFlags.custom}
                  dataAttr="property-lease-allow-custom-dates"
                  onChange={(on) => toggleLeaseOption("custom", on)}
                />
                <LeaseOptionCheckbox
                  label="Allow month-to-month"
                  checked={optionFlags.monthToMonth}
                  dataAttr="property-lease-allow-month-to-month"
                  onChange={(on) => toggleLeaseOption("monthToMonth", on)}
                />
              </>
            ) : null}
            {mode === "add" ? (
              <PropertyFormWizardRow label="Start from">
                <PropertyFormStartFromSelect
                  value={startFrom}
                  dataAttr="property-form-start-from"
                  onChange={(next) => {
                    setStartFrom(next);
                    if (next === "upload") handleDocumentModeChange("upload");
                    else if (next === "proplane") applyLeaseAddType(leaseAddType);
                  }}
                />
              </PropertyFormWizardRow>
            ) : (
              <PropertyFormWizardRow label="Start from">
                <PropertyFormStartFromFact
                  label={startFromFactLabel}
                  factDataAttr="property-lease-start-from-fact"
                  onReplace={
                    documentMode === "upload"
                      ? () => replaceLeaseFileRef.current?.click()
                      : undefined
                  }
                  replaceDataAttr="property-lease-replace-upload"
                />
              </PropertyFormWizardRow>
            )}
            {mode === "add" && startFrom === "copy" ? (
              <PropertyFormWizardRow label="Copy existing">
                <FieldSingleSelect
                  hideLabel
                  label="Copy existing"
                  labelClassName={WIZARD_LABEL_CLASS}
                  variant="cell"
                  className="min-w-[200px] max-w-[280px]"
                  value={copyFromLeaseId ?? ""}
                  dataAttr="property-lease-copy-existing"
                  options={copyLeaseOptions}
                  placeholder="Choose a lease"
                  onChange={(next) => setCopyFromLeaseId(next || null)}
                />
              </PropertyFormWizardRow>
            ) : null}
            {showAddendumRow ? (
              <PropertyFormWizardRow label="Co-signer / guarantor addendum">
                <FieldSingleSelect
                  hideLabel
                  label="Co-signer / guarantor addendum"
                  labelClassName={WIZARD_LABEL_CLASS}
                  variant="cell"
                  className="min-w-[200px] max-w-[280px]"
                  value={linkedGuarantorTemplateId ?? NO_LINK}
                  dataAttr="property-lease-addendum-link"
                  options={[{ value: NO_LINK, label: "None" }, ...addendumRowOptions]}
                  onChange={(next) => setLinkedGuarantorTemplateId(next === NO_LINK ? null : next)}
                />
              </PropertyFormWizardRow>
            ) : null}
          </PropertyFormWizardCard>
          <input
            ref={replaceLeaseFileRef}
            type="file"
            className="hidden"
            accept="application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            data-attr="property-lease-replace-upload-input"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              if (!file) return;
              setSectionsUploadFileName(file.name);
              if (documentMode !== "upload") handleDocumentModeChange("upload");
              onPickLeaseTemplateDoc(file);
            }}
          />
          {mode === "add" && startFrom === "upload" ? (
            <div className="mt-4">
              <ImportFileStrip
                dataAttr="property-lease-name-upload"
                chips={[".pdf", "up to 8 MB"]}
                accept={LEASE_UPLOAD_ACCEPT}
                busy={templateUploading || parsingLease}
                state={
                  templateUploading || parsingLease
                    ? { kind: "reading", fileName: sectionsUploadFileName ?? "your file" }
                    : { kind: "blank" }
                }
                onPickFile={(file) => {
                  setSectionsUploadFileName(file.name);
                  if (documentMode !== "upload") handleDocumentModeChange("upload");
                  if (!label.trim()) setLabel(uniqueFormLabel((templates ?? []).map((row) => row.label), deriveFormNameFromFileName(file.name)));
                  onPickLeaseTemplateDoc(file);
                }}
                onReread={() => {}}
              />
            </div>
          ) : null}
          {pendingLeaseImportCard}
          <FloatingLabelField
            id="property-lease-name"
            label="Lease document name"
            placeholder={typeMeta?.defaultLabel ?? "e.g. Room rental lease"}
            value={label}
            error={error && !label.trim() ? error : duplicateLeaseNameError}
            dataAttr="property-lease-name"
            onChange={(next) => {
              setError(null);
              setNameEdited(true);
              setLabel(next);
            }}
          />
          <PropertyFormWizardCard dataAttr="property-lease-fee-card">
            {mappableApplicationTemplates(readPropertyApplicationTemplates(sub)).length > 0 ? (
              <PropertyFormWizardRow label="Applications">
                <CheckboxMultiSelect
                  hideLabel
                  label="Applications for this lease"
                  variant="cell"
                  className="min-w-[150px] max-w-[240px]"
                  options={mappableApplicationTemplates(readPropertyApplicationTemplates(sub)).map((application) => ({
                    value: application.id,
                    label: normalizePropertyApplicationTemplateLabel(application.label) || "Application",
                  }))}
                  selected={applicationIds}
                  emptyLabel="No applications"
                  dataAttr="property-lease-applications"
                  onChange={(ids) => setApplicationIds(ids)}
                />
              </PropertyFormWizardRow>
            ) : null}
            <PropertyFormWizardRow label="Lease fee">
              <MoneyInput
                label="Lease fee"
                value={leaseFeeText}
                dataAttr="property-lease-fee-input"
                onChange={(raw) => setLeaseFeeText(sanitizeMoneyInput(raw))}
              />
            </PropertyFormWizardRow>
            <FormPromoCodesRow variant="wizard" kind="lease" propertyId={propertyId} propertyLabel={null} dataAttr="property-lease-promo-codes" />
          </PropertyFormWizardCard>
        </StepColumn>
      ) : null}
      {stepId === "document" ? (
        <StepColumn wide>
          <StepHeading title="Document" />
          {mode === "add" ? (
            <LeaseDocumentModeField
              mode={documentMode}
              onModeChange={handleDocumentModeChange}
              dataAttrPrefix="property"
              labelClassName={WIZARD_LABEL_CLASS}
              showDetail={false}
            />
          ) : null}
          {documentMode === "upload" ? (
            <div className="mt-4">
              <LeaseConfigForm
                variant="modal"
                embedded
                dataAttrPrefix="property"
                draft={draft}
                onDraftChange={(patch) => {
                  setError(null);
                  if ("leaseTemplateDocUrl" in patch) {
                    setHtmlOverride("");
                  }
                  setDraft((d) => ({ ...d, ...patch }));
                }}
                onStandardToggle={() => setError(null)}
                onPickLeaseTemplateDoc={onPickLeaseTemplateDoc}
                leaseTemplateError={leaseTemplateError}
                hideDocumentDropdown
                forcedSource="custom_format"
              />
            </div>
          ) : null}
          {documentMode === "upload" ? <div className="mt-4">{pendingLeaseImportCard}</div> : null}
          {importSource ? (
            <div
              className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm"
              data-attr="property-lease-detected-fields"
            >
              <span className="font-semibold text-foreground">
                {(() => {
                  const clauseCount = parseLeaseHtmlSections(displayHtml).length;
                  return clauseCount === 1 ? "1 clause" : `${clauseCount} clauses`;
                })()}{" "}
                on the paper · PDF fields highlighted in the editor
              </span>
            </div>
          ) : null}
          {showLeaseEditor ? (
            <div className="mt-4 flex min-h-[min(420px,55vh)] flex-col gap-3">
              {importSource && (importIssueSummary.length > 0 || importReviewError) ? (
                <section className="rounded-xl border border-border bg-accent/20 px-3 py-2.5 text-sm leading-relaxed text-foreground" data-attr="property-lease-import-review">
                  {importIssueSummary.length ? (
                    <ul className="space-y-0.5">
                      {importIssueSummary.map((issue) => (
                        <li key={issue.key}>
                          {issue.label}
                          {issue.pages ? <span className="text-muted-foreground"> · {issue.pages}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {importReviewError ? <p role="alert" className="mt-1.5 text-rose-700">{importReviewError}</p> : null}
                </section>
              ) : null}
              {/* An imported PDF is a deterministic parse, not an AI draft. */}
              <PropertyLeaseDocumentNotice html={noticeHtml} hideAiDraftBanner={Boolean(importSource)} />
              {saveReviewOpen ? (
                <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  <p className="font-semibold">Review before saving</p>
                  <p className="mt-1">
                    This lease still has items to fix. Ask PropLane Assistant, then save when it looks right — or{" "}
                    <button
                      type="button"
                      className="font-semibold underline"
                      onClick={() => {
                        setSaveReviewOpen(false);
                        void commitSave();
                      }}
                    >
                      save anyway
                    </button>
                    .
                  </p>
                </div>
              ) : null}
              {importSource ? (
                <div className="space-y-3" data-attr="property-lease-source-compare">
                  <div className="flex gap-2 lg:hidden" role="group" aria-label="Lease template comparison">
                    {(["original", "converted"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        aria-pressed={mobileTemplateTab === tab}
                        onClick={() => setMobileTemplateTab(tab)}
                        className="min-h-11 rounded-md border border-border px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        {tab === "original" ? "Original" : "Converted"}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <section className={`${mobileTemplateTab === "original" ? "block" : "hidden"} lg:block`}>
                      <h3 className="mb-2 text-sm font-semibold">Original PDF</h3>
                      {draft.leaseTemplateDocUrl ? (
                        <iframe title="Original lease template PDF" src={draft.leaseTemplateDocUrl} className="h-[min(380px,50vh)] w-full rounded-lg border border-border" />
                      ) : <p className="rounded-lg border border-border p-4 text-sm">Original PDF is not available.</p>}
                    </section>
                    <section className={`${mobileTemplateTab === "converted" ? "block" : "hidden"} lg:block`}>
                      <h3 className="mb-2 text-sm font-semibold">Converted lease</h3>
                      <PropertyLeaseDocumentEditor
                        className="min-h-[min(380px,50vh)]"
                        html={displayHtml}
                        baselineHtml={baselineHtml}
                        detectedFieldCount={importSource.sectionCount}
                        onChange={setHtmlOverride}
                      />
                    </section>
                  </div>
                </div>
              ) : (
                <PropertyLeaseDocumentEditor
                  className="min-h-[min(380px,50vh)] flex-1"
                  html={displayHtml}
                  baselineHtml={baselineHtml}
                  onChange={setHtmlOverride}
                />
              )}
            </div>
          ) : documentMode === "upload" && !draft.leaseTemplateDocUrl ? (
            <p className="mt-3 text-sm text-foreground">Upload a PDF to parse it into PropLane format.</p>
          ) : null}
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
