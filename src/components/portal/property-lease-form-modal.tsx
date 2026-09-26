"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
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
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import type { PropertyLeasePreviewHint } from "@/lib/property-lease-preview";
import { resolvePropertyLeaseEditHtml } from "@/lib/property-lease-edit";
import {
  PROPERTY_LEASE_TYPE_OPTIONS,
  createPropertyLeaseTemplate,
  normalizeLeaseTemplateKind,
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
  const [htmlOverride, setHtmlOverride] = useState("");
  const [templateUploading, setTemplateUploading] = useState(false);
  const [parsingLease, setParsingLease] = useState(false);
  const [importSource, setImportSource] = useState<Pick<ParseLeasePdfResult, "sourceSha256" | "sourceIssues" | "coverage"> | null>(null);
  const [importSourceReviewed, setImportSourceReviewed] = useState(false);
  const [transcribedUnreadableSourcePages, setTranscribedUnreadableSourcePages] = useState(false);
  const [importReviewError, setImportReviewError] = useState<string | null>(null);
  const [mobileTemplateTab, setMobileTemplateTab] = useState<"original" | "converted">("converted");
  const [saveReviewOpen, setSaveReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);

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
      return;
    }
    setLabel(PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === "long-term")!.defaultLabel);
    setKind("long-term");
    setDocumentMode("proplane_long_term");
    const applied = applyPropertyLeaseDocumentMode("proplane_long_term");
    setDraft((d) => ({ ...d, ...applied.draftFields }));
    setHtmlOverride("");
    setImportSource(null);
    setImportSourceReviewed(false);
    setTranscribedUnreadableSourcePages(false);
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
    const applied = applyPropertyLeaseDocumentMode(next);
    setDocumentMode(next);
    setKind(applied.kind);
    setDraft((d) => ({ ...d, ...applied.draftFields }));
  };

  const leaseTemplateError = error && documentMode === "upload" ? error : null;

  const onPickLeaseTemplateDoc = (file: File | null) => {
    readLeaseTemplateFile(
      file,
      (dataUrl, fileName) => {
        setError(null);
        setHtmlOverride("");
        setImportSource(null);
        setImportSourceReviewed(false);
        setTranscribedUnreadableSourcePages(false);
        setImportReviewError(null);
        setDraft((d) => ({ ...d, leaseTemplateDocUrl: dataUrl, leaseTemplateDocName: fileName }));
        if (dataUrl.startsWith("data:")) {
          showToast("Lease uploaded. Parsing runs after save in demo mode.");
          return;
        }
        setParsingLease(true);
        track("lease_import_started", { import_kind: "property_template" });
        void parseUploadedLeasePdf({ url: dataUrl, fileName, kind })
          .then((result) => {
            setImportSource({ sourceSha256: result.sourceSha256, sourceIssues: result.sourceIssues, coverage: result.coverage });
            if (!result.sourceIssues.some((issue) => issue.code === "unreadable_page")) setHtmlOverride(result.html);
            if (mode === "add") {
              setKind(result.inferredKind);
            }
            showToast(
              result.sourceIssues.length
                ? `Lease read with ${result.sourceIssues.length} page review issue${result.sourceIssues.length === 1 ? "" : "s"}. Compare and resolve them before saving the converted version.`
                : `Lease parsed into PropLane format (${result.sectionCount} section${result.sectionCount === 1 ? "" : "s"}).`,
            );
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
    const validationError = validateLeaseDraft(draft, documentMode);
    if (validationError) {
      setError(validationError);
      return;
    }

    const resolvedHtml = resolveHtmlOverrideToSave();
    const unreadableSourcePage = importSource?.sourceIssues.some((issue) => issue.code === "unreadable_page");
    if (documentMode === "upload" && resolvedHtml && unreadableSourcePage && !transcribedUnreadableSourcePages) {
      setImportReviewError("Transcribe every unreadable source page into the converted document, then confirm that resolution.");
      return;
    }
    if (documentMode === "upload" && resolvedHtml && importSource && !importSourceReviewed) {
      setImportReviewError("Compare the full converted document with the original PDF, resolve every listed issue, and confirm before saving.");
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
          leaseTemplateHtmlOverride: leaseFields.leaseTemplateHtmlOverride,
          leaseTemplateImportReview: leaseFields.leaseTemplateImportReview,
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

  const save = () => {
    if (documentMode === "upload" && htmlOverride.trim() && importSource && !importSourceReviewed) {
      setImportReviewError("Compare the full converted document with the original PDF and confirm before saving.");
      return;
    }
    if (showLeaseEditor && propertyLeaseNeedsAssistantReview(noticeHtml)) {
      setSaveReviewOpen(true);
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
      label: mode === "edit" ? "Name & applies to" : "Name",
      incomplete: !label.trim() || (mode === "edit" && applicationLeaseTerms.length === 0),
      summary: label.trim() || "Name this lease",
    },
    {
      id: "document",
      label: "Document",
      incomplete: documentMode === "upload" && !draft.leaseTemplateDocUrl,
      summary: documentModeMeta?.label ?? "Lease document",
    },
    { id: "preview", label: "Preview", summary: "What residents sign" },
  ];
  const current = Math.min(stepIdx, workspaceSteps.length - 1);
  const stepId = workspaceSteps[current]!.id;
  const dirty = Boolean(label.trim() || htmlOverride.trim() || draft.leaseTemplateDocUrl);

  const htmlPreview = (
    <div className="max-h-[70vh] overflow-auto rounded-2xl border border-border bg-card p-3 text-[13px] leading-relaxed text-foreground" data-attr="property-lease-html-preview">
      {displayHtml.trim() ? (
        <div dangerouslySetInnerHTML={{ __html: displayHtml }} />
      ) : (
        <p>No lease document yet.</p>
      )}
    </div>
  );

  if (!open) return null;

  return (
    <AddWorkspace
      title={mode === "add" ? "New lease" : "Edit lease"}
      steps={workspaceSteps}
      current={current}
      onJump={setStepIdx}
      onClose={dismiss}
      dirty={dirty}
      discardTitle="Discard this lease?"
      assistantContext={assistantContext}
      assistantScopeKey="Lease modal"
      sidePanel={htmlPreview}
      lastLabel="Save"
      lastDisabled={templateUploading || parsingLease || saving}
      onBeforeNext={() => {
        if (stepId === "name" && !label.trim()) {
          setError("Enter a name for this lease.");
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
        }
        setError(null);
        return true;
      }}
      busy={templateUploading || parsingLease || saving}
      onFinish={save}
      saveState={saving ? "Saving…" : parsingLease ? "Parsing…" : templateUploading ? "Uploading…" : "Not saved yet"}
      dataAttrPrefix="property-lease"
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
          <StepHeading title={mode === "edit" ? "Name & applies to" : "Name"} />
          <label className={WIZARD_LABEL_CLASS} htmlFor="property-lease-name">
            Lease document name
          </label>
          <Input
            id="property-lease-name"
            value={label}
            onChange={(e) => {
              setError(null);
              setLabel(e.target.value);
            }}
            placeholder={typeMeta?.defaultLabel ?? "e.g. Room rental lease"}
            data-attr="property-lease-name"
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
          ) : null}
          {showLeaseEditor ? (
            <div className="mt-4 flex min-h-[min(420px,55vh)] flex-col gap-3">
              {importSource ? (
                <section className="rounded-xl border border-amber-300 bg-amber-50/70 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-200" data-attr="property-lease-import-review">
                  <p className="font-semibold">Compare the converted lease with its original</p>
                  {importSource.sourceIssues.length ? (
                    <ul className="mt-2 space-y-1.5">
                      {importSource.sourceIssues.map((issue, index) => (
                        <li key={`${issue.code}-${issue.pageNumber ?? "doc"}-${index}`}>
                          {issue.pageNumber ? <strong>Page {issue.pageNumber}: </strong> : null}
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="mt-1">No extraction issues were detected. Check every page and field before saving.</p>}
                  {importSource.sourceIssues.some((issue) => issue.code === "unreadable_page") ? (
                    <label className="mt-3 flex items-start gap-2 font-semibold">
                      <input
                        type="checkbox"
                        checked={transcribedUnreadableSourcePages}
                        onChange={(event) => {
                          setTranscribedUnreadableSourcePages(event.target.checked);
                          setImportSourceReviewed(event.target.checked);
                          setImportReviewError(null);
                        }}
                      />
                      I transcribed every unreadable source page in the converted lease.
                    </label>
                  ) : (
                    <label className="mt-3 flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={importSourceReviewed}
                        onChange={(event) => {
                          setImportSourceReviewed(event.target.checked);
                          setImportReviewError(null);
                        }}
                        data-attr="property-lease-import-confirm"
                      />
                      <span>I compared the whole converted document with the original PDF and accounted for every listed issue.</span>
                    </label>
                  )}
                  {importReviewError ? <p role="alert" className="mt-2 text-rose-700">{importReviewError}</p> : null}
                </section>
              ) : null}
              <PropertyLeaseDocumentNotice html={noticeHtml} />
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
      {stepId === "preview" ? (
        <StepColumn wide>
          <StepHeading title="Preview" />
          {htmlPreview}
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
