"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Modal,
  ModalFooter,
  MODAL_FIELD_LABEL_CLASS,
  PORTAL_MODAL_FORM_FIELD_CLASS,
} from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";
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
  leaseAllowsManagerDocumentEdits,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { cn } from "@/lib/utils";

/** Resident / pipeline lease editor — same shell as the property Lease tab editor, but edits one lease packet. */
export function ManagerPipelineLeaseEditModal({
  open,
  row,
  onClose,
  onDone,
}: {
  open: boolean;
  row: LeasePipelineRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { showToast } = useAppUi();
  const { userId: managerUserId } = useManagerUserId();
  const [htmlOverride, setHtmlOverride] = useState("");
  const [saveReviewOpen, setSaveReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const canEdit = leaseAllowsManagerDocumentEdits(row);
  const editableHtml = leaseDocumentHtmlForSectionEdit(row);

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
  }, [open, row.id, row.updatedAtIso, row.generatedHtml, row.managerSectionEdits]);

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

  const commitSave = () => {
    if (!canEdit || !editableHtml) return;
    setSaving(true);
    const result = saveLeaseDocumentHtml(row.id, editorHtml, managerUserId);
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
    if (propertyLeaseNeedsAssistantReview(noticeHtml)) {
      setSaveReviewOpen(true);
      return;
    }
    commitSave();
  };

  return (
    <Modal
      open={open}
      title="Edit lease"
      description="Update this resident's lease format below, or type in chat to edit with PropLane Assistant."
      onClose={handleClose}
      dismissBlocked={saving}
      scrollableContent={false}
      panelClassName={MODAL_LARGE_PANEL_CLASS}
      assistantContext={assistantContext}
      assistantEditHint="Type in chat to edit the lease — changes apply after you confirm."
      assistantStorageScopeKey={`Lease packet edit · ${row.id}`}
      footer={
        canEdit && editableHtml ? (
          <ModalFooter className="w-full">
            <Button
              type="button"
              variant="primary"
              className="ml-auto rounded-full"
              disabled={saving}
              onClick={save}
              data-attr="resident-lease-edit-save"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </ModalFooter>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, "shrink-0")}>
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

        {!canEdit ? (
          <div className="rounded-2xl border border-border bg-accent/30 px-4 py-6 text-center text-sm text-muted">
            This lease has entered signing and its document body is locked.
          </div>
        ) : !editableHtml ? (
          <div className="rounded-2xl border border-border bg-accent/30 px-4 py-6 text-center text-sm text-muted">
            Generate a PropLane lease before editing. Uploaded PDF templates are preserved as the
            manager&apos;s original document and cannot be edited here.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <PropertyLeaseDocumentNotice html={noticeHtml} />
            {saveReviewOpen ? (
              <div className="shrink-0 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                <p className="font-semibold">Review before saving</p>
                <p className="mt-1">
                  This lease still has items to fix. Ask PropLane Assistant in the panel below, then save when it
                  looks right — or{" "}
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
              <p className={cn(MODAL_FIELD_LABEL_CLASS, "shrink-0")}>Lease format</p>
              <LeaseHtmlDirectEditor
                className="min-h-0 flex-1"
                html={displayHtml}
                baselineHtml={baselineHtml}
                onChange={(next) => setHtmlOverride(next)}
                showPersistBar={false}
              />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
