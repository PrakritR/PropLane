"use client";

import { useRef, useState } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, MODAL_FIELD_LABEL_CLASS, ModalFooter } from "@/components/ui/modal";
import { LEASE_PDF_MAX_BYTES, validateSignedLeasePdf } from "@/lib/lease-mark-signed.client";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

function formatKilobytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Decoded size of a base64 data URL, for the "412 KB" line under a stored PDF. */
function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? "" : dataUrl.slice(comma + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function todayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * "Mark lease as signed": the lease was signed on paper or in another tool and
 * the manager is filing that fact. Shows the PDF already on the row, or asks
 * for one when the row only holds a generated draft; the confirm stays off
 * until a PDF is in hand. The server decides whether marking is allowed
 * (`/api/portal-lease-pipeline/mark-signed`) — this surface only shows what
 * it refused.
 *
 * Mount it keyed on the lease id (`key={rowId}`) so a fresh open starts clean —
 * there is no effect resetting state on open.
 */
export function LeaseMarkSignedModal({
  open,
  row,
  onClose,
  onConfirm,
}: {
  open: boolean;
  row: LeasePipelineRow | null;
  onClose: () => void;
  /** Resolve with an error string to keep the modal open showing it; null on success. */
  onConfirm: (input: { file: File | null; signedOn: string }) => Promise<string | null>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [signedOn, setSignedOn] = useState(todayIsoDate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const storedPdf = row?.managerUploadedPdf?.originalDataUrl || row?.managerUploadedPdf?.dataUrl || "";
  const storedFileName = row?.managerUploadedPdf?.fileName?.trim() || "Uploaded lease.pdf";
  const hasGeneratedOnly = Boolean(row?.generatedHtml && !storedPdf);
  const hasPdf = Boolean(file || storedPdf);
  const residentName = row?.residentName?.trim() || "The resident";
  const unit = row?.unit?.trim() || "";

  const pickFile = (picked: File | null) => {
    if (!picked) return;
    const invalid = validateSignedLeasePdf(picked);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setFile(picked);
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Mark lease as signed"
      description={`Use this when the lease was signed outside PropLane. It becomes ${residentName}'s executed lease — no e-sign request is sent.`}
      dataAttr="lease-mark-signed-modal"
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose} data-attr="lease-mark-signed-cancel">
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!hasPdf || busy}
            loading={busy}
            data-attr="lease-mark-signed-confirm"
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const refusal = await onConfirm({ file, signedOn });
                if (refusal) setError(refusal);
              } finally {
                setBusy(false);
              }
            }}
          >
            Mark as signed
          </Button>
        </ModalFooter>
      }
    >
      <div className="grid gap-3">
        <div>
          <div className={MODAL_FIELD_LABEL_CLASS}>Resident</div>
          <div className="rounded-xl border border-border bg-secondary px-3 py-2 text-sm text-foreground">
            {residentName}
            {unit ? <span className="text-muted"> · {unit}</span> : null}
          </div>
        </div>

        <div>
          <div className={MODAL_FIELD_LABEL_CLASS}>Signed document</div>
          {file || storedPdf ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 px-3 py-2.5"
              data-attr="lease-mark-signed-document"
            >
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileText className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{file ? file.name : storedFileName}</div>
                <div className="text-xs text-muted">
                  {formatKilobytes(file ? file.size : dataUrlByteLength(storedPdf))}
                  {!file && row?.managerUploadedPdf?.uploadedAt
                    ? ` · uploaded ${new Date(row.managerUploadedPdf.uploadedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                    : null}
                  {" · "}
                  <button
                    type="button"
                    className="font-semibold text-primary hover:underline"
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                    data-attr="lease-mark-signed-replace"
                  >
                    Replace
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="w-full rounded-xl border border-dashed border-border px-3 py-4 text-center text-sm text-muted hover:border-primary/50"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              data-attr="lease-mark-signed-choose"
            >
              <span className="font-semibold text-primary">Choose the signed PDF</span>
              <div className="mt-1 text-xs">PDF only · up to {formatKilobytes(LEASE_PDF_MAX_BYTES)}</div>
            </button>
          )}
          {hasGeneratedOnly && !file ? (
            <p className="mt-2 rounded-xl bg-secondary px-3 py-2 text-xs leading-relaxed text-muted">
              This lease is a generated document with no uploaded copy. Attach the signed PDF — it replaces the generated
              text as the executed lease.
            </p>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            data-attr="lease-mark-signed-file"
            onChange={(event) => {
              pickFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
        </div>

        <label className="flex flex-col gap-0.5">
          <span className={MODAL_FIELD_LABEL_CLASS}>
            Signed on <span className="font-normal normal-case tracking-normal text-muted">(optional)</span>
          </span>
          <Input
            type="date"
            value={signedOn}
            max={todayIsoDate()}
            disabled={busy}
            onChange={(event) => setSignedOn(event.target.value)}
            data-attr="lease-mark-signed-date"
          />
        </label>

        {error ? (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger" role="alert" data-attr="lease-mark-signed-error">
            {error}
          </p>
        ) : null}

        <p className="rounded-xl bg-secondary px-3 py-2 text-xs leading-relaxed text-muted">
          PropLane keeps the PDF exactly as uploaded and records the lease as{" "}
          <span className="font-semibold text-foreground">Signed · off-platform</span> on the date above, with your name as
          countersigner. Rent, deposit and move-in charges post the same way an e-signed lease does.
        </p>
      </div>
    </Modal>
  );
}
