"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import {
  Modal,
  ModalFooter,
  MODAL_FIELD_LABEL_CLASS,
  PORTAL_MODAL_FORM_FIELD_CLASS,
} from "@/components/ui/modal";
import { MODAL_XL_PANEL_CLASS } from "@/components/ui/modal-styles";
import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";
import {
  propertyLeaseNeedsAssistantReview,
} from "@/components/portal/property-lease-document-notice";
import { buildAiGeneratedLeaseHtml } from "@/lib/generated-lease";
import { buildLeasePacketEditAssistantContext } from "@/lib/lease-assistant-context";
import { saveLeaseDocumentHtml } from "@/lib/lease-section-edit.client";
import {
  generateLeaseHtmlForRow,
  getLeaseDocumentHtml,
  leaseGenerationPreviewContextForRow,
  leaseApplicationSnapshotForRow,
  readLeasePipeline,
  resolveManagerLeaseGenerationRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { listLeaseTemplateGenerateChoices } from "@/lib/property-lease-template-sync";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import { getPropertyById } from "@/lib/rental-application/data";
import { cn } from "@/lib/utils";

export function LeaseGenerateModal({
  open,
  row,
  managerUserId,
  busy = false,
  replacesManagerEdits = false,
  onClose,
  onGenerated,
}: {
  open: boolean;
  row: LeasePipelineRow | null;
  managerUserId?: string | null;
  busy?: boolean;
  replacesManagerEdits?: boolean;
  onClose: () => void;
  /** Called after the draft is saved as this resident's lease. */
  onGenerated: (rowId: string) => void;
}) {
  const { showToast } = useAppUi();
  const [htmlOverride, setHtmlOverride] = useState("");
  const [saveReviewOpen, setSaveReviewOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  const submission = useMemo(() => {
    if (!row?.propertyId) return null;
    const prop = getPropertyById(row.propertyId);
    if (!prop?.listingSubmission || prop.listingSubmission.v !== 1) return null;
    return normalizeManagerListingSubmissionV1(prop.listingSubmission);
  }, [row?.propertyId]);

  const actionRow = useMemo(() => {
    if (!row) return row;
    return resolveManagerLeaseGenerationRow(row.id, managerUserId) ?? row;
  }, [row, managerUserId]);

  const application = useMemo(
    () => (actionRow ? leaseApplicationSnapshotForRow(actionRow) ?? {} : {}),
    [actionRow],
  );

  const choices = useMemo(() => {
    if (!actionRow || !submission) return [];
    return listLeaseTemplateGenerateChoices(
      submission,
      application,
      actionRow.leaseKind === "joint_bundle" ? "joint_bundle" : "individual",
    );
  }, [actionRow, submission, application]);

  const defaultChoiceId = choices[0]?.id ?? null;
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(defaultChoiceId);

  useEffect(() => {
    if (!open) return;
    setSelectedChoiceId(defaultChoiceId);
    setSaveReviewOpen(false);
  }, [open, defaultChoiceId, row?.id]);

  const selectedTemplateId = useMemo(
    () => choices.find((c) => c.id === selectedChoiceId)?.template.id ?? null,
    [choices, selectedChoiceId],
  );

  const draft = useMemo(() => {
    if (!actionRow || !open) return null;
    const ctx = leaseGenerationPreviewContextForRow(actionRow, managerUserId, selectedTemplateId);
    if (!ctx) return { error: "No application data on file." };
    const outcome = buildAiGeneratedLeaseHtml(ctx);
    if (outcome.kind !== "generated") return { error: outcome.error };
    return { html: outcome.html };
  }, [actionRow, open, managerUserId, selectedTemplateId]);

  const baselineHtml = useMemo(() => {
    if (!draft?.html) return "";
    return stripDisclosureReviewFromLeaseHtml(draft.html);
  }, [draft?.html]);

  useEffect(() => {
    if (!open) return;
    setHtmlOverride(baselineHtml);
    setSaveReviewOpen(false);
  }, [open, row?.id, selectedChoiceId, baselineHtml]);

  const editorHtml = htmlOverride.trim() || baselineHtml;
  const displayHtml = useMemo(() => stripDisclosureReviewFromLeaseHtml(editorHtml), [editorHtml]);

  const assistantContext = useMemo(
    () => (actionRow ? buildLeasePacketEditAssistantContext(actionRow) : ""),
    [actionRow],
  );

  const commitGenerate = () => {
    if (!actionRow || busy || generating) return;
    if (choices.length > 0 && !selectedTemplateId) return;
    if (!editorHtml.trim()) {
      showToast("No lease content to save.");
      return;
    }
    if (draft?.error) return;

    setGenerating(true);
    const res = generateLeaseHtmlForRow(actionRow.id, managerUserId, {
      discardManagerEdits: replacesManagerEdits,
      templateId: selectedTemplateId,
    });
    if (!res.ok) {
      setGenerating(false);
      showToast(res.error ?? "Could not generate lease.");
      return;
    }

    const rowAfter = readLeasePipeline(managerUserId).find((candidate) => candidate.id === actionRow.id);
    const generatedHtml = rowAfter ? getLeaseDocumentHtml(rowAfter)?.trim() ?? "" : "";
    if (editorHtml.trim() !== generatedHtml) {
      const saveRes = saveLeaseDocumentHtml(actionRow.id, editorHtml, managerUserId);
      setGenerating(false);
      if (!saveRes.ok) {
        showToast(saveRes.error);
        return;
      }
    } else {
      setGenerating(false);
    }

    showToast(`Lease generated (v${res.version}).`);
    onGenerated(actionRow.id);
  };

  const confirm = () => {
    if (propertyLeaseNeedsAssistantReview(editorHtml)) {
      setSaveReviewOpen(true);
      return;
    }
    commitGenerate();
  };

  const canGenerate = Boolean(editorHtml.trim() && !draft?.error && !(choices.length > 0 && !selectedTemplateId));
  const working = busy || generating;

  if (!row || !actionRow) return null;

  return (
    <Modal
      open={open}
      title={replacesManagerEdits ? "Regenerate lease" : "Generate lease"}
      onClose={onClose}
      dismissBlocked={working}
      scrollableContent={false}
      panelClassName={MODAL_XL_PANEL_CLASS}
      assistantContext={assistantContext}
      assistantEditHint="Type in chat to edit the lease — changes apply after you confirm."
      assistantStorageScopeKey={`Lease generate · ${actionRow.id}`}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="ml-auto rounded-full"
            data-attr="lease-generate-confirm"
            disabled={working || !canGenerate}
            onClick={confirm}
          >
            {working
              ? "Generating…"
              : "Generate lease"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, "shrink-0")}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="lease-generate-type">
            Lease type
          </label>
          {choices.length === 0 ? (
            <p className="text-sm text-muted">
              This property has no saved lease formats, so the draft uses PropLane&apos;s standard lease
              template. Add a lease format on the property&apos;s Lease tab to pick one here.
            </p>
          ) : (
            <NativeSelect
              id="lease-generate-type"
              value={selectedChoiceId ?? ""}
              onChange={(e) => setSelectedChoiceId(e.target.value || null)}
              disabled={working}
              data-attr="lease-generate-type-select"
            >
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </NativeSelect>
          )}
          {actionRow.leaseKind === "joint_bundle" ? (
            <p className="mt-2 text-xs text-muted">
              Bundle leases list every room in the bundle (or the entire home) and include all co-tenants on one
              document.
            </p>
          ) : null}
        </div>

        {draft?.error ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {draft.error}
          </p>
        ) : editorHtml ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {saveReviewOpen ? (
              <div className="shrink-0 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                <p className="font-semibold">Review before generating</p>
                <p className="mt-1">
                  This draft still has items to fix. Ask PropLane Assistant in the panel below, then generate when
                  it looks right — or{" "}
                  <button
                    type="button"
                    className="font-semibold underline"
                    onClick={() => {
                      setSaveReviewOpen(false);
                      commitGenerate();
                    }}
                  >
                    generate anyway
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
        ) : (
          <p className="text-sm text-muted">Choose a lease type to load the draft.</p>
        )}
      </div>
    </Modal>
  );
}
