"use client";

import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { Button } from "@/components/ui/button";
import {
  FloatingLabelField,
  MoneyInput,
  PanelSection,
  SegmentedControl,
  StepColumn,
  StepHeading,
  ToggleRow,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ImportFileStrip } from "@/components/portal/listing-wizard-v2/import-upload-step";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { usePropertyFormSetupSettings } from "@/lib/property-form-setup-settings.client";
import { deriveFormNameFromFileName } from "@/components/portal/pro-property-application-questions-panel";
import {
  LeaseConfigForm,
  LeaseDocumentModeField,
  readLeaseTemplateFile,
  type LeaseConfigDraft,
} from "@/components/portal/lease-config-form";
import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";
import { PropertyLeaseDocumentNotice, propertyLeaseNeedsAssistantReview } from "@/components/portal/property-lease-document-notice";
import { buildLeaseModalAssistantContext } from "@/lib/lease-assistant-context";
import { AGENT_PENDING_ACTIONS_EVENT } from "@/lib/axis-assistant/pending-actions-events";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  scopeLeaseDocumentHtmlForInlinePreview,
  stripDisclosureReviewFromLeaseHtml,
} from "@/lib/property-lease-document-display";
import type { PropertyLeasePreviewHint } from "@/lib/property-lease-preview";
import { resolvePropertyLeaseEditHtml } from "@/lib/property-lease-edit";
import {
  PROPERTY_LEASE_TYPE_OPTIONS,
  createPropertyLeaseTemplate,
  makePropertyLeaseTemplateId,
  normalizeLeaseTemplateKind,
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
import { CUSTOM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { track } from "@/lib/analytics/track-client";

async function sha256Text(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure import review is unavailable.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The lease-term choices an applicant can make, as "Applies to" boxes. */
const LEASE_APPLIES_TO_OPTIONS: { value: string; label: string }[] = [
  { value: "Long-term", label: "Long-term" },
  { value: "Month-to-Month", label: "Month-to-month" },
  { value: CUSTOM_LEASE_TERM, label: "Custom" },
  { value: SHORT_TERM_LEASE_TERM, label: "Short-term stay" },
];

/** Steps are Name, Document, Preview; the import review box is on Document. */
const DOCUMENT_STEP_INDEX = 1;

/**
 * F013: the class the rendered lease document's own serif/underline look is
 * scoped under — see `scopeLeaseDocumentHtmlForInlinePreview`. Never applied
 * to any editor chrome element, only to the div the document HTML is
 * injected into.
 */
export const LEASE_PREVIEW_DOCUMENT_SCOPE = "lease-document-preview-scope";

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
  demoMode?: boolean;
  canDelete?: boolean;
  onClose: () => void;
  onSave: (nextTemplates: PropertyLeaseTemplate[]) => boolean | Promise<boolean>;
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
  // F-editor d/F015: another of this property's lease templates whose form is
  // the co-signer/guarantor addendum — see `PropertyLeaseTemplate.linkedGuarantorLeaseTemplateId`.
  const [linkedGuarantorTemplateId, setLinkedGuarantorTemplateId] = useState<string | null>(null);
  const [htmlOverride, setHtmlOverride] = useState("");
  const [templateUploading, setTemplateUploading] = useState(false);
  /** F013/F002: the file name shown on the Sections step's dashed "Start from a file" card while reading. */
  const [sectionsUploadFileName, setSectionsUploadFileName] = useState<string | null>(null);
  const [parsingLease, setParsingLease] = useState(false);
  const [importSource, setImportSource] = useState<Pick<ParseLeasePdfResult, "sourceSha256" | "sourceIssues" | "coverage"> | null>(null);
  const [importSourceReviewed, setImportSourceReviewed] = useState(false);
  const [transcribedUnreadableSourcePages, setTranscribedUnreadableSourcePages] = useState(false);
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
  // P006/P009/P011: same per-property leasing-pipeline settings the
  // application editor's Setup step reads/writes — pipeline order, lease
  // signing fee (real charge path: `lease-signing-fee-checkout.server.ts`,
  // "each signer pays" per docs/agents/resident-payments.md), default lease.
  const formSetup = usePropertyFormSetupSettings(propertyId);
  // F007: a brand-new ("add" mode) lease has no id until the footer commit
  // creates it, but the Setup step's "Default for this property" toggle
  // needs a stable id to compare/patch against the moment the step is
  // reachable — generated once per open and reused as the created
  // template's real id at commit, exactly like the application editor's
  // `addModeTemplateId`.
  const [addModeLeaseTemplateId, setAddModeLeaseTemplateId] = useState<string | null>(null);

  // F013: inline duplicate-name validation — another lease already saved on
  // this property with the same (trimmed, case-insensitive) name.
  const duplicateLeaseNameError = useMemo(() => {
    const trimmed = label.trim().toLowerCase();
    if (!trimmed || !templates) return null;
    const clashes = templates.some(
      (candidate) => candidate.id !== template?.id && candidate.label.trim().toLowerCase() === trimmed,
    );
    return clashes ? `A lease named "${label.trim()}" already exists on this property.` : null;
  }, [label, templates, template?.id]);

  const source = leaseSourceFromDraft(draft);
  const typeMeta = useMemo(
    () => PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === kind),
    [kind],
  );
  const documentModeMeta = useMemo(
    () => PROPERTY_LEASE_DOCUMENT_MODE_OPTIONS.find((o) => o.id === documentMode),
    [documentMode],
  );

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
    setStepIdx(0);
    if (mode === "edit" && template) {
      const templateDraftFields = draftFromTemplate(template);
      const templateSource = leaseSourceFromDraft(templateDraftFields);
      const templateKind = normalizeLeaseTemplateKind(template.kind);
      setLabel(template.label);
      setKind(templateKind);
      setApplicationLeaseTerms([...(template.applicationLeaseTerms ?? [])]);
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
      } : null);
      setImportSourceReviewed(Boolean(template.leaseTemplateImportReview));
      setTranscribedUnreadableSourcePages(Boolean(template.leaseTemplateImportReview?.resolvedIssueCodes?.includes("unreadable_page")));
      setLinkedGuarantorTemplateId(template.linkedGuarantorLeaseTemplateId ?? null);
      setPendingLeaseImport(null);
      setPendingLeaseImportCompareOpen(false);
      setAddModeLeaseTemplateId(null);
      return;
    }
    setAddModeLeaseTemplateId(makePropertyLeaseTemplateId());
    setLabel(PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === "long-term")!.defaultLabel);
    setKind("long-term");
    setDocumentMode("proplane_long_term");
    const applied = applyPropertyLeaseDocumentMode("proplane_long_term");
    setDraft((d) => ({ ...d, ...applied.draftFields }));
    setHtmlOverride("");
    setImportSource(null);
    setImportSourceReviewed(false);
    setTranscribedUnreadableSourcePages(false);
    setLinkedGuarantorTemplateId(null);
    setPendingLeaseImport(null);
    setPendingLeaseImportCompareOpen(false);
  }, [open, mode, template]);

  useEffect(() => {
    if (!open || mode === "edit") return;
    const defaultLabel =
      documentMode === "proplane_short_term"
        ? PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === "short-term")?.defaultLabel
        : PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === "long-term")?.defaultLabel;
    if (defaultLabel) setLabel(defaultLabel);
  }, [documentMode, open, mode]);

  const handleDocumentModeChange = (next: PropertyLeaseDocumentMode) => {
    setError(null);
    setHtmlOverride("");
    setImportSource(null);
    setImportSourceReviewed(false);
    setTranscribedUnreadableSourcePages(false);
    setImportReviewError(null);
    setPendingLeaseImport(null);
    setPendingLeaseImportCompareOpen(false);
    const applied = applyPropertyLeaseDocumentMode(next);
    setDocumentMode(next);
    setKind(applied.kind);
    setDraft((d) => ({ ...d, ...applied.draftFields }));
  };

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
          setImportSourceReviewed(false);
          setTranscribedUnreadableSourcePages(false);
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
    setImportSource({ sourceSha256: p.sourceSha256, sourceIssues: p.sourceIssues, coverage: p.coverage });
    setImportSourceReviewed(false);
    setTranscribedUnreadableSourcePages(false);
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
    if (unreadableSourcePage && !transcribedUnreadableSourcePages) return "Type in every unreadable page, then check the box.";
    if (!importSourceReviewed) return "Check every page against the original PDF, then check the box.";
    return null;
  };

  const resolveHtmlOverrideToSave = (): string => {
    const trimmed = editorHtml.trim();
    if (!trimmed) return "";
    if (trimmed === baselineHtml.trim()) return "";
    return trimmed;
  };

  const dismiss = () => {
    setSaveReviewOpen(false);
    onClose();
  };

  const commitSave = async () => {
    if (duplicateLeaseNameError) {
      setError(duplicateLeaseNameError);
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
    if (documentMode === "upload" && resolvedHtml && importSource && importSourceReviewed) {
      try {
        leaseTemplateImportReview = {
          sourceSha256: importSource.sourceSha256,
          convertedHtmlSha256: await sha256Text(resolvedHtml),
          reviewedAtIso: new Date().toISOString(),
          templateVersion: `${template?.id ?? "new"}@${(template?.updatedAt ?? new Date().toISOString())}`,
          issueCodes: importSource.sourceIssues.map((issue) => issue.code),
          resolvedIssueCodes: unreadableSourcePage && transcribedUnreadableSourcePages ? ["unreadable_page"] : [],
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
          id: addModeLeaseTemplateId ?? makePropertyLeaseTemplateId(),
          leaseTemplateHtmlOverride: leaseFields.leaseTemplateHtmlOverride,
          leaseTemplateImportReview: leaseFields.leaseTemplateImportReview,
          linkedGuarantorLeaseTemplateId: linkedGuarantorTemplateId,
        };
        const next = [...(templates ?? []), created];
        if (!(await Promise.resolve(onSave(next)))) return;
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

      const next = updatePropertyLeaseTemplate(templates, template.id, {
        label: trimmedLabel,
        kind,
        applicationLeaseTerms,
        linkedGuarantorLeaseTemplateId: linkedGuarantorTemplateId,
        ...leaseFields,
      });
      if (!(await Promise.resolve(onSave(next)))) return;
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
      label: "Sections",
      incomplete: !label.trim() || (mode === "edit" && applicationLeaseTerms.length === 0),
      summary: label.trim() || "Name this lease",
    },
    {
      // P005: the studio's 3-step Name -> Form -> Setup. Kept the internal
      // id "document" (every `stepId === "document"` check below is
      // unchanged) and only renamed the rail label to "Form" to match.
      id: "document",
      label: "Form",
      incomplete: documentMode === "upload" && !draft.leaseTemplateDocUrl,
      summary: documentModeMeta?.label ?? "Lease document",
    },
    {
      id: "setup",
      label: "Setup",
      summary: formSetup.loaded
        ? `${(formSetup.leasingPipeline.leaseSigningFeeCents ?? 0) > 0 ? "Fee set" : "No lease fee"} · ${
            formSetup.leasingPipeline.pipelineOrder === "lease_then_application" ? "Lease first" : "Application first"
          }`
        : "Lease fee, pipeline",
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
    open, value: { label, kind, documentMode, draft, applicationLeaseTerms, linkedGuarantorTemplateId, htmlOverride, sectionsUploadFileName, importSource, importSourceReviewed, transcribedUnreadableSourcePages, pendingLeaseImport, stepIdx, addModeLeaseTemplateId },
    restore: (saved) => { setLabel(saved.label); setKind(saved.kind); setDocumentMode(saved.documentMode); setDraft(saved.draft); setApplicationLeaseTerms(saved.applicationLeaseTerms); setLinkedGuarantorTemplateId(saved.linkedGuarantorTemplateId); setHtmlOverride(saved.htmlOverride); setSectionsUploadFileName(saved.sectionsUploadFileName); setImportSource(saved.importSource); setImportSourceReviewed(saved.importSourceReviewed); setTranscribedUnreadableSourcePages(saved.transcribedUnreadableSourcePages); setPendingLeaseImport(saved.pendingLeaseImport); setStepIdx(saved.stepIdx); setAddModeLeaseTemplateId(saved.addModeLeaseTemplateId); },
  });

  if (!open) return null;

  return (
    <AddWorkspace
      title={mode === "add" ? "New lease" : "Edit lease"}
      steps={workspaceSteps}
      current={current}
      onJump={setStepIdx}
      onClose={() => { workspaceDraft.preserve(); (dismiss)(); }}
      dirty={dirty}
      discardTitle="Discard this lease?"
      assistantContext={assistantContext}
      assistantScopeKey="Lease modal"
      sidePanel={htmlPreview}
      lastLabel={mode === "add" ? "Add lease" : "Save"}
      lastDisabled={templateUploading || parsingLease || saving || Boolean(duplicateLeaseNameError) || Boolean(pendingLeaseImport)}
      onBeforeNext={() => {
        if (stepId === "name" && !label.trim()) {
          setError("Enter a name for this lease.");
          return false;
        }
        if (stepId === "name" && duplicateLeaseNameError) return false;
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
      saveState={saving ? "Saving…" : parsingLease ? "Parsing…" : templateUploading ? "Uploading…" : "Not saved yet"}
      dataAttrPrefix="property-lease"
      numberedSteps
      finishDataAttr={mode === "add" ? "property-lease-add-save" : "property-lease-edit-save"}
      footerNote={error ? <span className="text-sm text-rose-600">{error}</span> : null}
      dangerAction={
        mode === "edit" && canDelete && onDelete ? (
          <button
            type="button"
            className="min-h-[44px] rounded-full border border-red-200 bg-card px-6 text-[14px] font-bold text-red-700"
            onClick={() => void handleDelete()}
            data-attr="property-lease-delete"
          >
            Delete
          </button>
        ) : null
      }
    >
      {stepId === "name" ? (
        <StepColumn>
          <StepHeading title="Sections" />
          {/* F002/F013: the same dashed drop-zone card the listing wizard and
              the application editor use for "Start from a file". A quick-pick
              lands the file straight from this first step — full document-mode
              choices still live on the Form (document) step. */}
          {mode === "add" || !draft.leaseTemplateDocUrl ? (
            <ImportFileStrip
              dataAttr="property-lease-name-upload"
              chips={[".pdf", ".docx", "Your own lease", "up to 5 MB"]}
              accept="application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              busy={templateUploading || parsingLease}
              state={
                templateUploading || parsingLease
                  ? { kind: "reading", fileName: sectionsUploadFileName ?? "your file" }
                  : { kind: "blank" }
              }
              onPickFile={(file) => {
                setSectionsUploadFileName(file.name);
                if (documentMode !== "upload") handleDocumentModeChange("upload");
                if (!label.trim()) setLabel(deriveFormNameFromFileName(file.name));
                onPickLeaseTemplateDoc(file);
              }}
              onReread={() => {}}
            />
          ) : (
            <p className="mb-3 text-xs text-muted" data-attr="property-lease-name-uploaded">
              Using {draft.leaseTemplateDocName || "your uploaded lease"}.
            </p>
          )}
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
              setLabel(next);
            }}
          />
          {mode === "edit" ? (
            <fieldset className="mt-4 space-y-2">
              <legend className={WIZARD_LABEL_CLASS}>Applies to</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {LEASE_APPLIES_TO_OPTIONS.map((term) => (
                  <label key={term.value} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border text-primary"
                      checked={applicationLeaseTerms.includes(term.value)}
                      onChange={(e) =>
                        setApplicationLeaseTerms((currentTerms) =>
                          e.target.checked
                            ? [...new Set([...currentTerms, term.value])]
                            : currentTerms.filter((value) => value !== term.value),
                        )
                      }
                      data-attr={`property-lease-applies-to-${term.value.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                    />
                    {term.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
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
          {showLeaseEditor ? (
            <div className="mt-4 flex min-h-[min(420px,55vh)] flex-col gap-3">
              {importSource ? (
                // Light tokens only: the portal is light-themed, so `dark:`
                // variants (OS-driven) painted this box brown on dark-mode Macs.
                <section className="rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2.5 text-sm leading-relaxed text-amber-950" data-attr="property-lease-import-review">
                  <p className="font-semibold">Check against the original PDF</p>
                  {importIssueSummary.length ? (
                    <ul className="mt-1 space-y-0.5">
                      {importIssueSummary.map((issue) => (
                        <li key={issue.key}>
                          {issue.label}
                          {issue.pages ? <span className="text-amber-900/70"> · {issue.pages}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <label className="mt-2 flex cursor-pointer items-start gap-2 font-medium">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-primary"
                      checked={unreadableSourcePage ? transcribedUnreadableSourcePages : importSourceReviewed}
                      onChange={(event) => {
                        if (unreadableSourcePage) setTranscribedUnreadableSourcePages(event.target.checked);
                        setImportSourceReviewed(event.target.checked);
                        setImportReviewError(null);
                      }}
                      data-attr="property-lease-import-confirm"
                    />
                    {unreadableSourcePage
                      ? "I typed in every unreadable page"
                      : "I checked every page against the original"}
                  </label>
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
                      <LeaseHtmlDirectEditor
                        className="min-h-[min(380px,50vh)]"
                        html={displayHtml}
                        baselineHtml={stripDisclosureReviewFromLeaseHtml(baselineHtml)}
                        onChange={(next) => {
                          setHtmlOverride(next);
                          setImportSourceReviewed(false);
                          setTranscribedUnreadableSourcePages(false);
                        }}
                        showPersistBar={false}
                      />
                    </section>
                  </div>
                </div>
              ) : (
                <LeaseHtmlDirectEditor
                  className="min-h-[min(380px,50vh)] flex-1"
                  html={displayHtml}
                  baselineHtml={stripDisclosureReviewFromLeaseHtml(baselineHtml)}
                  onChange={setHtmlOverride}
                  showPersistBar={false}
                />
              )}
            </div>
          ) : documentMode === "upload" && !draft.leaseTemplateDocUrl ? (
            <p className="mt-3 text-sm text-foreground">Upload a PDF to parse it into PropLane format.</p>
          ) : null}
        </StepColumn>
      ) : null}
      {stepId === "setup" ? (
        <StepColumn>
          <StepHeading title="Setup" />
          {!formSetup.loaded ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <div>
              {/* F014: ONE lease fee — toggle + amount, no separate segmented
                  None/Custom control. */}
              <PanelSection title="Lease fee">
                <ToggleRow
                  label="Charge a lease fee"
                  checked={(formSetup.leasingPipeline.leaseSigningFeeCents ?? 0) > 0}
                  dataAttr="lease-setup-fee-toggle"
                  onChange={(next) =>
                    void formSetup.patch({
                      leasingPipeline: {
                        ...formSetup.leasingPipeline,
                        leaseSigningFeeCents: next ? formSetup.leasingPipeline.leaseSigningFeeCents || 10000 : 0,
                      },
                    })
                  }
                />
                {(formSetup.leasingPipeline.leaseSigningFeeCents ?? 0) > 0 ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className={WIZARD_LABEL_CLASS}>Lease fee</span>
                    <MoneyInput
                      label="Lease fee"
                      dataAttr="lease-setup-fee-amount"
                      value={String((formSetup.leasingPipeline.leaseSigningFeeCents ?? 0) / 100)}
                      placeholder="100"
                      onChange={(raw) => {
                        const cents = Math.round((parseFloat(raw) || 0) * 100);
                        void formSetup.patch({
                          leasingPipeline: { ...formSetup.leasingPipeline, leaseSigningFeeCents: cents },
                        });
                      }}
                    />
                  </div>
                ) : null}
              </PanelSection>
              {/* F015: another of this property's OWN lease templates — never itself. */}
              <PanelSection title="Linked co-signer / guarantor addendum">
                <FieldSingleSelect
                  label="A co-signer or guarantor signs"
                  labelClassName={WIZARD_LABEL_CLASS}
                  value={linkedGuarantorTemplateId ?? "__none__"}
                  dataAttr="lease-setup-linked-guarantor"
                  options={[
                    { value: "__none__", label: "None" },
                    ...(templates ?? [])
                      .filter((candidate) => candidate.id !== template?.id)
                      .map((candidate) => ({ value: candidate.id, label: candidate.label })),
                  ]}
                  onChange={(next) => {
                    setLinkedGuarantorTemplateId(next === "__none__" ? null : next);
                    setError(null);
                  }}
                />
              </PanelSection>
              <PanelSection title="Pipeline order">
                <SegmentedControl
                  ariaLabel="Pipeline order"
                  value={formSetup.leasingPipeline.pipelineOrder}
                  dataAttrPrefix="lease-setup-pipeline-order"
                  options={[
                    { value: "application_then_lease", label: "Application first" },
                    { value: "lease_then_application", label: "Lease first" },
                  ]}
                  onChange={(next) =>
                    void formSetup.patch({
                      leasingPipeline: { ...formSetup.leasingPipeline, pipelineOrder: next },
                    })
                  }
                />
              </PanelSection>
              {(() => {
                // F007: reachable in "add" mode too — the property's default
                // lease should be settable before the first Save, not only
                // once the lease already exists. `thisLeaseId` is the real
                // saved id in edit mode, or the pending id "add" mode will
                // create the lease WITH at commit (see the `mode === "add"`
                // branch of `save` below).
                const thisLeaseId = mode === "edit" ? template?.id ?? null : addModeLeaseTemplateId;
                if (!thisLeaseId) return null;
                return (
                  <PanelSection title="Default">
                    <ToggleRow
                      label={`Default ${typeMeta?.label.toLowerCase() ?? "long-term"} lease for this property`}
                      checked={formSetup.leasingPipeline.defaultLeaseTemplateId === thisLeaseId}
                      dataAttr="lease-setup-default-toggle"
                      onChange={(next) =>
                        void formSetup.patch({
                          leasingPipeline: {
                            ...formSetup.leasingPipeline,
                            defaultLeaseTemplateId: next ? thisLeaseId : null,
                          },
                        })
                      }
                    />
                  </PanelSection>
                );
              })()}
            </div>
          )}
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
