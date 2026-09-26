"use client";

import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

export function ImportedLeasePlacementReviewModal({
  row,
  onClose,
  onConfirm,
}: {
  row: LeasePipelineRow | null;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!row) return null;

  const confirm = async () => {
    if (!acknowledged || busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalDialog
      open
      title="Compare the source and final lease"
      onClose={onClose}
      size="wizard"
      dataAttr="imported-lease-placement-review"
      primaryAction={{
        label: "Confirm reviewed lease",
        onClick: confirm,
        disabled: !acknowledged || busy,
        loading: busy,
        dataAttr: "imported-lease-placement-confirm",
      }}
      secondaryAction={{ label: "Cancel", onClick: onClose }}
    >
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="min-w-0 space-y-2">
            <h3 className="font-semibold">Original PDF</h3>
            {row.templateDocumentUrl ? (
              <iframe
                title="Original lease template PDF"
                src={row.templateDocumentUrl}
                className="h-[55vh] min-h-80 w-full rounded-lg border border-border"
              />
            ) : (
              <p className="rounded-lg border border-border p-4 text-sm">Original PDF is unavailable.</p>
            )}
          </section>
          <section className="min-w-0 space-y-2">
            <h3 className="font-semibold">Final placement lease</h3>
            {row.generatedHtml ? (
              <iframe
                title="Final placement lease including PropLane Terms Rider"
                srcDoc={row.generatedHtml}
                sandbox=""
                className="h-[55vh] min-h-80 w-full rounded-lg border border-border bg-white"
              />
            ) : (
              <p className="rounded-lg border border-border p-4 text-sm">Generated lease is unavailable.</p>
            )}
          </section>
        </div>
        <label className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50/70 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-200">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-1"
          />
          <span>I compared the complete converted source with this final placement lease, reviewed the separately appended PropLane Terms Rider, and accept any differences or conflicts shown above.</span>
        </label>
        {busy ? <p role="status" className="text-sm">Saving the reviewed version…</p> : null}
      </div>
    </PortalDialog>
  );
}
