"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import {
  LeaseConfigForm,
  LeaseDocumentModeField,
  readLeaseTemplateFile,
  type LeaseConfigDraft,
} from "@/components/portal/lease-config-form";
import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";
import { PropertyLeaseDocumentNotice } from "@/components/portal/property-lease-document-notice";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import {
  persistLeaseConfigToPropertyIds,
  persistManagerListingSubmission,
  type LeaseConfigFields,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import { buildLeaseModalAssistantContext } from "@/lib/lease-assistant-context";
import type { PropertyLeasePreviewHint } from "@/lib/property-lease-preview";
import { resolvePropertyLeaseEditHtml } from "@/lib/property-lease-edit";
import {
  applyPropertyLeaseDocumentMode,
  documentModeFromLease,
  leaseSourceFromDraft,
  type PropertyLeaseDocumentMode,
} from "@/lib/property-lease-source";
import {
  normalizeLeaseTemplateKind,
  readPropertyLeaseTemplates,
  syncLegacyLeaseFieldsFromTemplates,
  updatePropertyLeaseTemplate,
  type PropertyLeaseTemplate,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";
import { parseUploadedLeasePdf } from "@/lib/lease-template-parse.client";

function draftFromSubmission(sub: ManagerListingSubmissionV1): LeaseConfigDraft {
  return {
    leaseConfigMode: sub.leaseConfigMode ?? "standard",
    leaseCustomKind: sub.leaseCustomKind === "document" ? "document" : "terms",
    customLeaseTerms: sub.customLeaseTerms ?? "",
    leaseTemplateDocUrl: sub.leaseTemplateDocUrl ?? null,
    leaseTemplateDocName: sub.leaseTemplateDocName ?? "",
  };
}

function validateLeaseDraft(draft: LeaseConfigDraft, mode: PropertyLeaseDocumentMode): string | null {
  if (mode !== "upload") return null;
  return draft.leaseTemplateDocUrl?.trim()
    ? null
    : "Upload your lease template (PDF), or use a PropLane default.";
}

function leaseFieldsFromDraft(draft: LeaseConfigDraft): LeaseConfigFields {
  return {
    leaseConfigMode: draft.leaseConfigMode ?? "standard",
    leaseCustomKind: draft.leaseCustomKind === "document" ? "document" : "terms",
    customLeaseTerms: draft.customLeaseTerms ?? "",
    leaseTemplateDocUrl: draft.leaseTemplateDocUrl ?? null,
    leaseTemplateDocName: draft.leaseTemplateDocName ?? "",
  };
}

const fieldLabelClass = "mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-muted";

/** Edit lease configuration for a property — same options as the listing wizard Lease step. */
export function ManagerLeaseEditorModal({
  open,
  title = "Lease",
  sub,
  saveTarget,
  propertyIds,
  managerUserId,
  propertyHint,
  propertyId,
  propertyLabel,
  demoMode = false,
  templateId,
  templates,
  onTemplatesSaved,
  onClose,
  onSaved,
  showToast,
}: {
  open: boolean;
  title?: string;
  sub: ManagerListingSubmissionV1;
  saveTarget?: ManagerPropertySaveTarget;
  /** When set, Save applies the same lease fields to every id (bulk edit). */
  propertyIds?: string[];
  managerUserId: string;
  propertyHint?: PropertyLeasePreviewHint;
  /** Listing / pending property id for the assistant (from Properties). */
  propertyId?: string | null;
  propertyLabel?: string | null;
  demoMode?: boolean;
  /** When editing one template in a multi-lease property panel. */
  templateId?: string;
  templates?: PropertyLeaseTemplate[];
  onTemplatesSaved?: (templates: PropertyLeaseTemplate[]) => boolean;
  onClose: () => void;
  onSaved: () => void;
  showToast: (m: string) => void;
}) {
  const [draft, setDraft] = useState<LeaseConfigDraft>(() => draftFromSubmission(sub));
  const [leaseKind, setLeaseKind] = useState<PropertyLeaseTemplateKind>("long-term");
  const [documentMode, setDocumentMode] = useState<PropertyLeaseDocumentMode>("proplane_long_term");
  const [templateLabel, setTemplateLabel] = useState("");
  const [htmlOverride, setHtmlOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [templateUploading, setTemplateUploading] = useState(false);
  const [parsingLease, setParsingLease] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFromSubmission(sub));
    setError(null);
    const primary = templateId && templates
      ? templates.find((t) => t.id === templateId)
      : readPropertyLeaseTemplates(sub)[0];
    const primaryKind = normalizeLeaseTemplateKind(primary?.kind);
    const primarySource = leaseSourceFromDraft(draftFromSubmission(sub));
    setLeaseKind(primaryKind);
    setDocumentMode(documentModeFromLease(primarySource, primaryKind));
    if (templateId && templates) {
      setTemplateLabel(templates.find((t) => t.id === templateId)?.label ?? "");
      setHtmlOverride(primary?.leaseTemplateHtmlOverride?.trim() ?? "");
    } else {
      setTemplateLabel("");
      setHtmlOverride("");
    }
  }, [open, sub, templateId, templates]);

  const source = leaseSourceFromDraft(draft);

  const handleDocumentModeChange = (next: PropertyLeaseDocumentMode) => {
    setError(null);
    setHtmlOverride("");
    const applied = applyPropertyLeaseDocumentMode(next);
    setDocumentMode(next);
    setLeaseKind(applied.kind);
    setDraft((d) => ({ ...d, ...applied.draftFields }));
  };

  function applyLeaseConfigAndKind(
    base: ManagerListingSubmissionV1,
    leaseFields: LeaseConfigFields,
  ): ManagerListingSubmissionV1 {
    const withFields: ManagerListingSubmissionV1 = { ...base, ...leaseFields };
    const templates = readPropertyLeaseTemplates(withFields);
    if (templates.length === 0) return withFields;
    const [primary, ...rest] = templates;
    return syncLegacyLeaseFieldsFromTemplates(withFields, [
      { ...primary!, kind: leaseKind, updatedAt: new Date().toISOString() },
      ...rest,
    ]);
  }

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
        templateKind: leaseKind,
        hint: propertyHint,
        demo: demoMode,
      }),
    [previewSub, templateDraft, source, leaseKind, propertyHint, demoMode],
  );

  const editorHtml = htmlOverride.trim() || baselineHtml;
  const displayHtml = useMemo(() => stripDisclosureReviewFromLeaseHtml(editorHtml), [editorHtml]);
  const showLeaseEditor = documentMode !== "upload" || Boolean(editorHtml.trim());

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
        void parseUploadedLeasePdf({ url: dataUrl, fileName, kind: leaseKind })
          .then((result) => {
            setHtmlOverride(result.html);
            setLeaseKind(result.inferredKind);
            showToast(
              `Lease parsed into PropPlane format (${result.sectionCount} section${result.sectionCount === 1 ? "" : "s"}).`,
            );
          })
          .catch((err) => {
            console.error("manager-lease-editor-modal: parse failed", err);
            showToast(err instanceof Error ? err.message : "Could not parse that lease PDF.");
          })
          .finally(() => setParsingLease(false));
      },
      showToast,
      setTemplateUploading,
    );
  };

  const bulkIds = propertyIds?.filter((id) => id.trim()) ?? [];
  const isBulkSave = bulkIds.length > 0;

  const save = (): boolean => {
    const validationError = validateLeaseDraft(draft, documentMode);
    if (validationError) {
      setError(validationError);
      return false;
    }
    const leaseFields = {
      ...leaseFieldsFromDraft(draft),
      leaseTemplateHtmlOverride: (() => {
        const trimmed = editorHtml.trim();
        if (!trimmed || trimmed === baselineHtml.trim()) return "";
        return trimmed;
      })(),
    };

    if (isBulkSave) {
      const { saved, failed } = persistLeaseConfigToPropertyIds(managerUserId, bulkIds, leaseFields, leaseKind);
      if (saved === 0) {
        showToast("Could not save lease settings.");
        return false;
      }
      if (failed > 0) {
        showToast(`Updated lease settings for ${saved} properties (${failed} could not be saved).`);
      } else if (saved === 1) {
        showToast("Lease settings saved.");
      } else {
        showToast(`Updated lease settings for ${saved} properties`);
      }
      onClose();
      onSaved();
      return true;
    }

    if (!saveTarget) {
      showToast("Could not save lease settings.");
      return false;
    }

    if (templateId && templates && onTemplatesSaved) {
      const nextTemplates = updatePropertyLeaseTemplate(templates, templateId, {
        label: templateLabel.trim() || templates.find((t) => t.id === templateId)?.label || "Lease",
        kind: leaseKind,
        leaseConfigMode: leaseFields.leaseConfigMode,
        leaseCustomKind: leaseFields.leaseCustomKind,
        customLeaseTerms: leaseFields.customLeaseTerms,
        leaseTemplateDocUrl: leaseFields.leaseTemplateDocUrl,
        leaseTemplateDocName: leaseFields.leaseTemplateDocName,
        leaseTemplateHtmlOverride: leaseFields.leaseTemplateHtmlOverride,
      });
      if (!onTemplatesSaved(nextTemplates)) return false;
      showToast("Lease template saved.");
      onClose();
      onSaved();
      return true;
    }

    const next = applyLeaseConfigAndKind(sub, leaseFields);
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast("Could not save lease settings.");
      return false;
    }
    showToast("Lease settings saved.");
    onClose();
    onSaved();
    return true;
  };

  const dismiss = () => onClose();

  const assistantContext = buildLeaseModalAssistantContext({
    propertyId,
    propertyIds: bulkIds.length ? bulkIds : undefined,
    propertyLabel: propertyLabel ?? propertyHint?.buildingName ?? title,
    currentSource: source,
    templateKind: leaseKind === "short-term" || leaseKind === "long-term" ? leaseKind : "long-term",
  });

  return (
    <Modal
      open={open}
      title={title}
      onClose={dismiss}
      panelClassName="max-w-2xl"
      assistantContext={assistantContext}
      assistantEditHint="Type in chat to edit the lease — changes apply after you confirm."
      assistantStorageScopeKey="Lease modal"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            disabled={templateUploading || parsingLease}
            onClick={() => save()}
            data-attr="property-lease-edit-save"
          >
            {templateUploading ? "Uploading…" : parsingLease ? "Parsing lease…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        {bulkIds.length > 1 ? (
          <p className="text-sm text-muted">
            These settings apply to the selected agreement type on all {bulkIds.length} properties. The other
            agreement type stays unchanged.
          </p>
        ) : null}
        <p className="text-sm text-muted">
          Choose a PropLane default or upload a PDF. Edit the lease format below — or ask the PropLane assistant to add
          sections.
        </p>
        {templateId ? (
          <div>
            <label
              className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.12em] text-muted"
              htmlFor="property-lease-edit-name"
            >
              Lease name
            </label>
            <Input
              id="property-lease-edit-name"
              value={templateLabel}
              onChange={(e) => setTemplateLabel(e.target.value)}
              data-attr="property-lease-edit-name"
            />
          </div>
        ) : null}
        {!templateId ? (
          <LeaseDocumentModeField
            mode={documentMode}
            onModeChange={handleDocumentModeChange}
            dataAttrPrefix="property"
          />
        ) : null}
        {documentMode === "upload" ? (
          <LeaseConfigForm
            variant="modal"
            embedded
            hideDocumentDropdown
            forcedSource="custom_format"
            dataAttrPrefix="property"
            draft={draft}
            onDraftChange={(patch) => {
              setError(null);
              if ("leaseTemplateDocUrl" in patch) setHtmlOverride("");
              setDraft((d) => ({ ...d, ...patch }));
            }}
            onStandardToggle={() => setError(null)}
            onPickLeaseTemplateDoc={onPickLeaseTemplateDoc}
            leaseTemplateError={leaseTemplateError}
          />
        ) : null}

        {showLeaseEditor ? (
          <div className="flex min-h-[min(360px,50vh)] flex-col gap-3">
            <PropertyLeaseDocumentNotice html={editorHtml} />
            <div className="flex min-h-0 flex-1 flex-col">
              <p className={fieldLabelClass}>Lease format</p>
              <LeaseHtmlDirectEditor
                className="min-h-[min(320px,45vh)] flex-1"
                html={displayHtml}
                baselineHtml={stripDisclosureReviewFromLeaseHtml(baselineHtml)}
                onChange={setHtmlOverride}
                showPersistBar={false}
              />
            </div>
          </div>
        ) : documentMode === "upload" && !draft.leaseTemplateDocUrl ? (
          <p className="text-sm text-muted">Upload a PDF to parse it into PropPlane format.</p>
        ) : null}
      </div>
    </Modal>
  );
}
