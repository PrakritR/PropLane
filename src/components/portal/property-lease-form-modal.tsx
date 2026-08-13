"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Modal,
  ModalFooter,
  MODAL_FIELD_LABEL_CLASS,
  PORTAL_MODAL_FORM_FIELD_CLASS,
  PORTAL_MODAL_FORM_GRID_CLASS,
} from "@/components/ui/modal";
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
import { parseUploadedLeasePdf } from "@/lib/lease-template-parse.client";

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
  onSave: (nextTemplates: PropertyLeaseTemplate[]) => boolean;
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
  const [htmlOverride, setHtmlOverride] = useState("");
  const [templateUploading, setTemplateUploading] = useState(false);
  const [parsingLease, setParsingLease] = useState(false);
  const [saveReviewOpen, setSaveReviewOpen] = useState(false);

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
  const showLeaseEditor = documentMode !== "upload" || Boolean(editorHtml.trim());

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === "edit" && template) {
      const templateDraftFields = draftFromTemplate(template);
      const templateSource = leaseSourceFromDraft(templateDraftFields);
      const templateKind = normalizeLeaseTemplateKind(template.kind);
      setLabel(template.label);
      setKind(templateKind);
      setDocumentMode(documentModeFromLease(templateSource, templateKind));
      setDraft(templateDraftFields);
      setHtmlOverride(template.leaseTemplateHtmlOverride?.trim() ?? "");
      return;
    }
    setLabel(PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === "long-term")!.defaultLabel);
    setKind("long-term");
    setDocumentMode("proplane_long_term");
    const applied = applyPropertyLeaseDocumentMode("proplane_long_term");
    setDraft((d) => ({ ...d, ...applied.draftFields }));
    setHtmlOverride("");
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
        setDraft((d) => ({ ...d, leaseTemplateDocUrl: dataUrl, leaseTemplateDocName: fileName }));
        if (dataUrl.startsWith("data:")) {
          showToast("Lease uploaded. Parsing runs after save in demo mode.");
          return;
        }
        setParsingLease(true);
        void parseUploadedLeasePdf({ url: dataUrl, fileName, kind })
          .then((result) => {
            setHtmlOverride(result.html);
            if (mode === "add") {
              setKind(result.inferredKind);
            }
            showToast(
              `Lease parsed into PropPlane format (${result.sectionCount} section${result.sectionCount === 1 ? "" : "s"}).`,
            );
          })
          .catch((err) => {
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

  const commitSave = () => {
    const validationError = validateLeaseDraft(draft, documentMode);
    if (validationError) {
      setError(validationError);
      showToast(validationError);
      return;
    }

    const trimmedLabel = label.trim() || typeMeta?.defaultLabel || "Lease";
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
    };

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
      };
      const next = [...(templates ?? []), created];
      if (!onSave(next)) return;
      showToast("Lease added.");
      dismiss();
      return;
    }

    if (!template || !templates) {
      showToast("Could not save lease.");
      return;
    }

    const next = updatePropertyLeaseTemplate(templates, template.id, {
      label: trimmedLabel,
      kind,
      ...leaseFields,
    });
    if (!onSave(next)) return;
    showToast("Lease saved.");
    dismiss();
  };

  const save = () => {
    if (showLeaseEditor && propertyLeaseNeedsAssistantReview(noticeHtml)) {
      setSaveReviewOpen(true);
      return;
    }
    commitSave();
  };

  const handleDelete = () => {
    if (!canDelete || !onDelete) return;
    if (!window.confirm("Delete this lease? This cannot be undone.")) return;
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

  return (
    <Modal
      open={open}
      title={mode === "add" ? "New lease" : "Edit lease"}
      description={
        mode === "add"
          ? "Choose a PropLane default or upload a PDF. Edit the lease format below, or type in chat to edit with PropLane Assistant."
          : "Update the lease name and format below, or type in chat to edit with PropLane Assistant."
      }
      onClose={dismiss}
      panelClassName="max-w-4xl"
      assistantContext={assistantContext}
      assistantEditHint="Type in chat to edit the lease — changes apply after you confirm."
      assistantStorageScopeKey="Lease modal"
      footer={
        <ModalFooter className="w-full">
          {mode === "edit" && canDelete && onDelete ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-red-200 text-red-700 hover:bg-red-50"
              onClick={handleDelete}
              data-attr="property-lease-delete"
            >
              Delete
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            className="ml-auto rounded-full"
            disabled={templateUploading || parsingLease}
            onClick={save}
            data-attr={mode === "add" ? "property-lease-add-save" : "property-lease-edit-save"}
          >
            {templateUploading ? "Uploading…" : parsingLease ? "Parsing lease…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        {mode === "add" ? (
          <div className="space-y-3">
            <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
              <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
                <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="property-lease-name">
                  Lease document name
                </label>
                <Input
                  id="property-lease-name"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={typeMeta?.defaultLabel ?? "e.g. Room rental lease"}
                  data-attr="property-lease-name"
                />
              </div>
              <LeaseDocumentModeField
                mode={documentMode}
                onModeChange={handleDocumentModeChange}
                dataAttrPrefix="property"
                labelClassName={MODAL_FIELD_LABEL_CLASS}
                fieldClassName={PORTAL_MODAL_FORM_FIELD_CLASS}
                showDetail={false}
              />
            </div>
            {documentModeMeta ? (
              <p className="text-xs leading-relaxed text-muted">{documentModeMeta.detail}</p>
            ) : null}
          </div>
        ) : (
          <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="property-lease-name">
              Lease document name
            </label>
            <Input
              id="property-lease-name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={typeMeta?.defaultLabel ?? "e.g. Room rental lease"}
              data-attr="property-lease-name"
            />
          </div>
        )}

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
          <div className="flex min-h-[min(420px,55vh)] flex-col gap-3">
            <PropertyLeaseDocumentNotice html={noticeHtml} />
            {saveReviewOpen ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                <p className="font-semibold">Review before saving</p>
                <p className="mt-1">
                  This lease still has items to fix. Ask PropLane Assistant in the panel below, then save when it looks
                  right — or{" "}
                  <button
                    type="button"
                    className="font-semibold underline"
                    onClick={() => {
                      setSaveReviewOpen(false);
                      commitSave();
                    }}
                  >
                    save anyway
                  </button>
                  .
                </p>
              </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col">
              <p className={MODAL_FIELD_LABEL_CLASS}>Lease format</p>
              <LeaseHtmlDirectEditor
                className="min-h-[min(380px,50vh)] flex-1"
                html={displayHtml}
                baselineHtml={stripDisclosureReviewFromLeaseHtml(baselineHtml)}
                onChange={(next) => setHtmlOverride(next)}
                showPersistBar={false}
              />
            </div>
          </div>
        ) : documentMode === "upload" && !draft.leaseTemplateDocUrl ? (
          <p className="text-sm text-muted">Upload a PDF above to parse it into PropPlane format.</p>
        ) : null}
      </div>
    </Modal>
  );
}
