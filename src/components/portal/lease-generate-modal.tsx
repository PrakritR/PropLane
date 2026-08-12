"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter, MODAL_WARNING_BOX_CLASS } from "@/components/ui/modal";
import { buildAiGeneratedLeaseHtml } from "@/lib/generated-lease";
import {
  generateLeaseHtmlForRow,
  leaseGenerationPreviewContextForRow,
  leaseApplicationSnapshotForRow,
  resolveManagerLeaseGenerationRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { listLeaseTemplateGenerateChoices } from "@/lib/property-lease-template-sync";
import { LEASE_AI_REVIEW_DISCLAIMER } from "@/lib/lease-templates/types";
import { getPropertyById } from "@/lib/rental-application/data";

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
  /** Called after a successful generate — open the lease editor. */
  onGenerated: (rowId: string) => void;
}) {
  const { showToast } = useAppUi();
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
  }, [open, defaultChoiceId, row?.id]);

  const selectedTemplateId = useMemo(
    () => choices.find((c) => c.id === selectedChoiceId)?.template.id ?? null,
    [choices, selectedChoiceId],
  );

  const preview = useMemo(() => {
    if (!actionRow || !open) return null;
    const ctx = leaseGenerationPreviewContextForRow(actionRow, managerUserId, selectedTemplateId);
    if (!ctx) return { error: "No application data on file." };
    const outcome = buildAiGeneratedLeaseHtml(ctx);
    if (outcome.kind !== "generated") return { error: outcome.error };
    return { html: outcome.html };
  }, [actionRow, open, managerUserId, selectedTemplateId]);

  const confirm = () => {
    if (!actionRow || busy) return;
    if (choices.length > 0 && !selectedTemplateId) return;
    const res = generateLeaseHtmlForRow(actionRow.id, managerUserId, {
      discardManagerEdits: replacesManagerEdits,
      templateId: selectedTemplateId,
    });
    if (res.ok) {
      showToast(`Lease generated (v${res.version}).`);
      onGenerated(actionRow.id);
    } else {
      showToast(res.error ?? "Could not generate lease.");
    }
  };

  if (!row || !actionRow) return null;

  return (
    <Modal
      open={open}
      title={replacesManagerEdits ? "Regenerate lease" : "Generate lease"}
      onClose={onClose}
      dismissBlocked={busy}
      fullPage={false}
      panelClassName="max-w-5xl"
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            data-attr="lease-generate-confirm"
            disabled={busy || Boolean(preview?.error) || (choices.length > 0 && !selectedTemplateId)}
            onClick={() => confirm()}
          >
            {busy ? "Generating…" : replacesManagerEdits ? "Regenerate lease" : "Generate lease"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <p className={MODAL_WARNING_BOX_CLASS}>
          <strong>AI-generated draft.</strong> {LEASE_AI_REVIEW_DISCLAIMER}
        </p>
        {replacesManagerEdits ? (
          <p className={MODAL_WARNING_BOX_CLASS}>
            <strong>Manager edits will be replaced.</strong> Regeneration rebuilds this lease from the current
            application and listing terms. Your saved body edits will not be kept.
          </p>
        ) : null}

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Lease type</p>
          {choices.length === 0 ? (
            <p className="text-sm text-muted">
              This property has no saved lease formats, so the draft uses PropLane&apos;s standard lease
              template. Add a lease format on the property&apos;s Lease tab to pick one here.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {choices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  data-attr={`lease-generate-type-${choice.scenario}-${choice.id}`}
                  disabled={busy}
                  onClick={() => setSelectedChoiceId(choice.id)}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                    selectedChoiceId === choice.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-foreground hover:bg-accent/40"
                  }`}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {actionRow.leaseKind === "joint_bundle" ? (
            <p className="text-xs text-muted">
              Bundle leases list every room in the bundle (or the entire home) and include all co-tenants on one
              document.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Preview</p>
          {preview?.error ? (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {preview.error}
            </p>
          ) : preview?.html ? (
            <iframe
              title="Lease preview"
              className="h-[min(50vh,28rem)] w-full rounded-xl border border-border bg-white"
              srcDoc={preview.html}
              sandbox=""
            />
          ) : (
            <p className="text-sm text-muted">Choose a lease type to preview the draft.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
