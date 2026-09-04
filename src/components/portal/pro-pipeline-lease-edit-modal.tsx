"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import {
  Modal,
  ModalFooter,
  MODAL_FIELD_LABEL_CLASS,
  PORTAL_MODAL_FORM_FIELD_CLASS,
} from "@/components/ui/modal";
import { MODAL_TALL_PANEL_CLASS, MODAL_XL_PANEL_CLASS } from "@/components/ui/modal-styles";
import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";
import { LeaseAiReviewAcknowledgment } from "@/components/portal/lease-ai-review-acknowledgment";
import { PortalRecordShareLinkButton } from "@/components/portal/portal-record-share-link-button";
import {
  PropertyLeaseDocumentNotice,
  propertyLeaseNeedsAssistantReview,
} from "@/components/portal/property-lease-document-notice";
import { buildLeasePacketEditAssistantContext } from "@/lib/lease-assistant-context";
import { AGENT_PENDING_ACTIONS_EVENT } from "@/lib/axis-assistant/pending-actions-events";
import {
  leaseDocumentHtmlForSectionEdit,
  saveLeaseDocumentHtml,
} from "@/lib/lease-section-edit.client";
import {
  cachedLandlordLegalName,
  LEASE_LANDLORD_PLACEHOLDER,
} from "@/lib/manager-landlord-profile";
import {
  generateLeaseHtmlForRow,
  leaseAllowsManagerDocumentEdits,
  leaseApplicationSnapshotForRow,
  leaseGenerationSupportedForRow,
  resolveManagerLeaseGenerationRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { leaseUsesAiGeneratedHtml } from "@/lib/lease-templates/types";
import { listLeaseTemplateGenerateChoices } from "@/lib/property-lease-template-sync";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import { getPropertyById } from "@/lib/rental-application/data";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN } from "@/components/portal/portal-data-table";
import { cn } from "@/lib/utils";

type ManagerPipelineLeaseEditModalProps = {
  open: boolean;
  row: LeasePipelineRow;
  managerUserId?: string | null;
  onClose: () => void;
  onDone: () => void;
  showDownload?: boolean;
  onDownload?: () => void;
  showUpload?: boolean;
  onUpload?: () => void;
  uploadLabel?: string;
  uploadDisabled?: boolean;
  showDelete?: boolean;
  onDelete?: () => void;
  showShare?: boolean;
  showRegenerate?: boolean;
  /** @deprecated Prefer `managerUserId` — regenerate runs inside this editor without opening another modal. */
  onRegenerate?: (templateId: string | null) => void;
  regenerateLabel?: string;
  regenerateDisabled?: boolean;
};

/** Resident / pipeline lease editor — same shell as the property Lease tab editor, but edits one lease packet. */
export function ManagerPipelineLeaseEditModal({
  open,
  row,
  managerUserId,
  onClose,
  onDone,
  showDownload = false,
  onDownload,
  showUpload = false,
  onUpload,
  uploadLabel = "Upload",
  uploadDisabled = false,
  showDelete = false,
  onDelete,
  showShare = false,
  showRegenerate = false,
  onRegenerate,
  regenerateLabel = "Regenerate",
  regenerateDisabled = false,
}: ManagerPipelineLeaseEditModalProps) {
  const { showToast } = useAppUi();
  const { userId: sessionManagerUserId } = useManagerUserId();
  const resolvedManagerUserId = managerUserId ?? sessionManagerUserId;
  const [htmlOverride, setHtmlOverride] = useState("");
  const [saveReviewOpen, setSaveReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const usesAiHtml = leaseUsesAiGeneratedHtml(row);

  const canEdit = leaseAllowsManagerDocumentEdits(row);
  const editableHtml = leaseDocumentHtmlForSectionEdit(row);
  const generationSupported = leaseGenerationSupportedForRow(row).ok;

  const actionRow = useMemo(
    () => resolveManagerLeaseGenerationRow(row.id, resolvedManagerUserId) ?? row,
    [row, resolvedManagerUserId],
  );

  const submission = useMemo(() => {
    if (!actionRow.propertyId) return null;
    const prop = getPropertyById(actionRow.propertyId);
    if (!prop?.listingSubmission || prop.listingSubmission.v !== 1) return null;
    return normalizeManagerListingSubmissionV1(prop.listingSubmission);
  }, [actionRow.propertyId]);

  const application = useMemo(
    () => leaseApplicationSnapshotForRow(actionRow) ?? {},
    [actionRow],
  );

  const generationChoices = useMemo(() => {
    if (!submission) return [];
    return listLeaseTemplateGenerateChoices(
      submission,
      application,
      actionRow.leaseKind === "joint_bundle" ? "joint_bundle" : "individual",
    );
  }, [actionRow.leaseKind, application, submission]);

  const defaultChoiceId = generationChoices[0]?.id ?? null;
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(defaultChoiceId);

  const selectedTemplateId = useMemo(
    () => generationChoices.find((choice) => choice.id === selectedChoiceId)?.template.id ?? null,
    [generationChoices, selectedChoiceId],
  );

  const baselineHtml = useMemo(() => {
    if (!editableHtml) return "";
    return stripDisclosureReviewFromLeaseHtml(editableHtml);
  }, [editableHtml]);

  const editorHtml = htmlOverride.trim() || baselineHtml;
  const displayHtml = useMemo(() => stripDisclosureReviewFromLeaseHtml(editorHtml), [editorHtml]);
  const noticeHtml = editorHtml;

  const documentLabel = useMemo(() => {
    const name = row.residentName?.trim() || "Resident";
    const unit = row.unit?.trim();
    return unit ? `${name} · ${unit}` : name;
  }, [row.residentName, row.unit]);

  useEffect(() => {
    if (!open) return;
    const html = leaseDocumentHtmlForSectionEdit(row);
    setHtmlOverride(html ? stripDisclosureReviewFromLeaseHtml(html) : "");
    setSaveReviewOpen(false);
    setReviewAcknowledged(false);
    setSelectedChoiceId(defaultChoiceId);
  }, [open, row.id, row.updatedAtIso, row.generatedHtml, row.managerSectionEdits, defaultChoiceId]);

  const assistantContext = useMemo(() => buildLeasePacketEditAssistantContext(row), [row]);

  const refreshFromAssistant = useCallback(() => {
    onDone();
  }, [onDone]);

  useEffect(() => {
    if (!open) return;
    const onActions = () => refreshFromAssistant();
    window.addEventListener(AGENT_PENDING_ACTIONS_EVENT, onActions);
    return () => window.removeEventListener(AGENT_PENDING_ACTIONS_EVENT, onActions);
  }, [open, refreshFromAssistant]);

  const handleClose = () => {
    onClose();
  };

  const landlordLegalName = cachedLandlordLegalName();
  const landlordNameMissing = !landlordLegalName.trim();
  const draftShowsPlaceholder = Boolean(editorHtml.includes(LEASE_LANDLORD_PLACEHOLDER));

  const runInPlaceRegenerate = () => {
    if (regenerating || regenerateDisabled || saving) return;
    if (onRegenerate) {
      onRegenerate(selectedTemplateId);
      return;
    }
    if (!resolvedManagerUserId) return;
    if (landlordNameMissing || draftShowsPlaceholder) {
      showToast("Add your full name in Settings → Profile, then regenerate this lease.");
      return;
    }
    setRegenerating(true);
    const res = generateLeaseHtmlForRow(row.id, resolvedManagerUserId, {
      discardManagerEdits: Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl),
      templateId: selectedTemplateId,
    });
    setRegenerating(false);
    if (!res.ok) {
      showToast(res.error ?? "Could not regenerate lease.");
      return;
    }
    showToast(`Lease regenerated (v${res.version}).`);
    setReviewAcknowledged(false);
    setSaveReviewOpen(false);
    onDone();
  };

  const commitSave = () => {
    if (!canEdit || !editableHtml) return;
    setSaving(true);
    const result = saveLeaseDocumentHtml(row.id, editorHtml, resolvedManagerUserId);
    setSaving(false);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    showToast("Lease saved.");
    onDone();
    onClose();
  };

  const save = () => {
    if (usesAiHtml && !reviewAcknowledged) {
      showToast("Confirm that you have reviewed this AI-generated draft before saving.");
      return;
    }
    if (propertyLeaseNeedsAssistantReview(noticeHtml)) {
      setSaveReviewOpen(true);
      return;
    }
    commitSave();
  };

  const showSave = canEdit && Boolean(editableHtml);
  const showGenerationFormat = canEdit && generationSupported;
  const hasFooterActions =
    showSave || showDownload || showUpload || showDelete || showShare || showRegenerate;
  const footerBtnClass = cn(RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN, "rounded-full");
  const deleteBtnClass = cn(
    footerBtnClass,
    "border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline",
  );

  return (
    <Modal
      open={open}
      title="Edit lease"
      description="Update this resident's lease format below, or type in chat to edit with PropLane Assistant."
      onClose={handleClose}
      dismissBlocked={saving || regenerating}
      dense
      scrollableContent={false}
      panelClassName={cn(
        MODAL_XL_PANEL_CLASS,
        MODAL_TALL_PANEL_CLASS,
        "min-h-[min(85dvh,52rem)]",
      )}
      assistantDefaultExpanded={false}
      assistantContext={assistantContext}
      assistantEditHint="Type in chat to edit the lease — changes apply after you confirm."
      assistantStorageScopeKey={`Lease packet edit · ${row.id}`}
      footer={
        hasFooterActions ? (
          <ModalFooter className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {showDelete ? (
                <Button
                  type="button"
                  variant="outline"
                  className={deleteBtnClass}
                  data-attr="resident-lease-delete"
                  onClick={onDelete}
                >
                  Delete
                </Button>
              ) : null}
              {showDownload ? (
                <Button
                  type="button"
                  variant="outline"
                  className={footerBtnClass}
                  data-attr="resident-lease-download"
                  onClick={onDownload}
                >
                  Download
                </Button>
              ) : null}
              {showUpload ? (
                <Button
                  type="button"
                  variant="outline"
                  className={footerBtnClass}
                  data-attr="resident-lease-upload"
                  disabled={uploadDisabled}
                  onClick={onUpload}
                >
                  {uploadLabel}
                </Button>
              ) : null}
              {showShare ? (
                <PortalRecordShareLinkButton
                  kind="lease"
                  recordId={row.id}
                  className={footerBtnClass}
                  dataAttr="resident-lease-share"
                  recordTitle={row.residentName?.trim() || row.unit?.trim() || row.propertyId}
                />
              ) : null}
              {showRegenerate ? (
                <Button
                  type="button"
                  variant="outline"
                  className={footerBtnClass}
                  data-attr="resident-lease-regenerate"
                  disabled={regenerateDisabled || regenerating}
                  onClick={runInPlaceRegenerate}
                >
                  {regenerating ? "Generating…" : regenerateLabel}
                </Button>
              ) : null}
            </div>
            {showSave ? (
              <div className="ml-auto flex items-center gap-3">
                {/* A dead button with no stated reason reads as a broken feature:
                    the review tick is REQUIRED before an AI-drafted lease can be
                    saved, so name that instead of leaving the manager clicking. */}
                {usesAiHtml && !reviewAcknowledged ? (
                  <span className="text-xs text-muted" data-attr="resident-lease-save-blocked-reason">
                    Confirm you have reviewed the draft above to save.
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="primary"
                  className="rounded-full"
                  disabled={saving || (usesAiHtml && !reviewAcknowledged)}
                  onClick={save}
                  data-attr="resident-lease-edit-save"
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : null}
          </ModalFooter>
        ) : null
      }
    >
      <div className="grid h-full min-h-0 flex-1 grid-rows-[auto_auto_minmax(0,1fr)] gap-2">
        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, "min-w-0")}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="resident-lease-document-name">
            Lease document name
          </label>
          <Input
            id="resident-lease-document-name"
            value={documentLabel}
            readOnly
            disabled
            data-attr="resident-lease-document-name"
          />
        </div>

        {showGenerationFormat ? (
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, "min-w-0")}>
            <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="resident-lease-generate-type">
              Lease format to generate
            </label>
            {generationChoices.length === 0 ? (
              <p className="text-sm text-muted">
                No saved property lease formats — PropLane&apos;s standard template is used when you
                regenerate.
              </p>
            ) : (
              <NativeSelect
                id="resident-lease-generate-type"
                value={selectedChoiceId ?? ""}
                onChange={(e) => setSelectedChoiceId(e.target.value || null)}
                data-attr="resident-lease-generate-type-select"
              >
                {generationChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
        ) : null}

        {!canEdit ? (
          <div className="rounded-2xl border border-border bg-accent/30 px-4 py-6 text-center text-sm text-muted">
            This lease has entered signing and its document body is locked.
          </div>
        ) : !editableHtml ? (
          <div className="rounded-2xl border border-border bg-accent/30 px-4 py-6 text-center text-sm text-muted">
            Generate or upload a lease document to edit it here. Use Regenerate with the format
            above, or Upload in the footer.
          </div>
        ) : (
          <div className="grid min-h-[min(42vh,28rem)] min-h-0 grid-rows-[auto_minmax(12rem,1fr)] gap-1 overflow-hidden">
            <div className="flex shrink-0 flex-col gap-2">
              <PropertyLeaseDocumentNotice html={noticeHtml} hideAiDraftBanner={usesAiHtml} />
              {usesAiHtml ? (
                <LeaseAiReviewAcknowledgment
                  checked={reviewAcknowledged}
                  onCheckedChange={setReviewAcknowledged}
                />
              ) : null}
              {saveReviewOpen ? (
                <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  <p className="font-semibold">Review before saving</p>
                  <p className="mt-1">
                    This lease still has items to fix. Ask PropLane Assistant in the panel below, then save when it
                    looks right.
                  </p>
                </div>
              ) : null}
              <p className={MODAL_FIELD_LABEL_CLASS}>Document view</p>
            </div>
            <LeaseHtmlDirectEditor
              className="min-h-[min(38vh,24rem)] min-h-0 h-full flex-1"
              html={displayHtml}
              baselineHtml={baselineHtml}
              onChange={(next) => setHtmlOverride(next)}
              showPersistBar={false}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
