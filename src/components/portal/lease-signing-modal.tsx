"use client";

import { useMemo, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { DEMO_LEASE_SIGN_PREPARE_EVENT } from "@/lib/demo/demo-playback";
import { LEASE_ESIGN_CONSENT_TEXT, LEASE_ESIGN_CONSENT_VERSION } from "@/lib/lease-execution-evidence";
import { getLeaseDocumentHtml, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";

/**
 * Which document the signer is agreeing to, so consent cannot outlive it.
 *
 * `row` is live in the resident portal (`resident-lease-panel.tsx` derives
 * `pipelineRow` with `useMemo` off synced rows), and this modal renders the
 * document straight from it — the uploaded PDF when there is one, otherwise the
 * generated HTML. So a manager re-uploading or regenerating while the resident
 * has the affirmation ticked would swap the document under an existing consent
 * and let them sign one they never read. `lease-execution-evidence.ts` hashes
 * whatever is current AT signature time, so it would faithfully record a
 * signature over the new document — the evidence layer cannot catch this.
 *
 * Identity is deliberately narrow: only fields that change WHICH document is
 * rendered. Widening it to the whole row would clear the box on every
 * background sync that appended a thread message.
 */
function signedDocumentSubject(row: LeasePipelineRow): string {
  return [
    row.managerUploadedPdf?.dataUrl ? "upload" : "generated",
    row.managerUploadedPdf?.fileName ?? "",
    row.managerUploadedPdf?.uploadedAt ?? "",
    row.generatedAtIso ?? "",
    String(row.pdfVersion ?? ""),
    String(row.versionNumber ?? ""),
  ].join("~");
}

export function LeaseSigningModal({
  row,
  signerName,
  signerRoleLabel,
  onSign,
  onClose,
}: {
  row: LeasePipelineRow;
  signerName: string;
  signerRoleLabel: string;
  /** `consentVersion` is the affirmation the signer accepted to reach this call. */
  onSign: (signatureName: string, consentVersion: string) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const [sigName, setSigName] = useState(signerName);
  const [agreed, setAgreed] = useState(false);
  const [signed, setSigned] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Drop the affirmation if the document changes under it. Done during render
  // (React's "adjust state when props change" pattern) so the new document is
  // never painted with the old consent still ticked. Skipped once `signed` is
  // true: the affirmation has already been consumed and the modal is closing,
  // and the write itself moves the row.
  const documentSubject = signedDocumentSubject(row);
  const [agreedDocument, setAgreedDocument] = useState(documentSubject);
  if (!signed && agreedDocument !== documentSubject) {
    setAgreedDocument(documentSubject);
    setAgreed(false);
  }

  useEffect(() => {
    const onPrepare = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name?.trim();
      if (name) setSigName(name);
      setAgreed(true);
    };
    window.addEventListener(DEMO_LEASE_SIGN_PREPARE_EVENT, onPrepare as EventListener);
    return () => window.removeEventListener(DEMO_LEASE_SIGN_PREPARE_EVENT, onPrepare as EventListener);
  }, []);

  const now = useMemo(() => formatPacificDateTime(new Date()), []);

  const canSign = sigName.trim().length >= 2 && agreed;

  const handleSign = async () => {
    if (!canSign) return;
    setSubmitting(true);
    const ok = await Promise.resolve(onSign(sigName.trim(), LEASE_ESIGN_CONSENT_VERSION));
    setSubmitting(false);
    if (!ok) return;
    setSigned(true);
    window.setTimeout(() => onClose(), 700);
  };

  return (
    <Modal
      open
      title="Sign lease agreement"
      description={`${row.unit} · ${row.residentName}`}
      onClose={onClose}
      assistantContext="Sign lease"
      panelClassName={MODAL_LARGE_PANEL_CLASS}
      footer={
        signed ? undefined : (
          <ModalFooter>
            <Button
              type="button"
              className="rounded-full"
              data-attr="lease-sign-confirm"
              disabled={!canSign || submitting}
              onClick={handleSign}
            >
              {submitting ? "Signing..." : "Sign lease"}
            </Button>
          </ModalFooter>
        )
      }
    >
      {(row.generatedHtml || row.managerUploadedPdf?.dataUrl) ? (
        <div className="mb-4 overflow-hidden rounded-xl border border-border">
          {row.managerUploadedPdf?.dataUrl ? (
            <iframe
              title="Lease document"
              src={row.managerUploadedPdf.dataUrl}
              className="h-[min(24vh,220px)] w-full bg-card"
            />
          ) : (
            <iframe
              title="Lease document"
              srcDoc={getLeaseDocumentHtml(row) ?? ""}
              sandbox="allow-same-origin"
              className="h-[min(24vh,220px)] w-full bg-card"
            />
          )}
        </div>
      ) : null}

      {signed ? (
        <div className="rounded-2xl border px-5 py-5 text-center portal-banner-success">
          <p className="text-2xl font-black text-emerald-700">✓ Signed</p>
          <p className="mt-2 text-sm text-muted">Your electronic signature has been recorded. Closing this window…</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-[0.12em] text-muted">{signerRoleLabel}</label>
            <p className="mt-0.5 text-xs text-muted">Type exactly as it should appear on the signed document.</p>
            <input
              type="text"
              value={sigName}
              onChange={(e) => setSigName(e.target.value)}
              disabled={submitting}
              data-attr="lease-sign-name"
              placeholder={signerName || signerRoleLabel}
              className="mt-2 w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
            />
            {sigName.trim().length >= 2 ? (
              <p
                className="mt-2 text-center text-xl text-foreground"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontStyle: "italic" }}
              >
                {sigName}
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-border bg-accent/30 px-4 py-3 text-xs text-muted">
            <p className="font-semibold text-muted">Signing date & time</p>
            <p className="mt-0.5">{now}</p>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm text-muted shadow-sm">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              disabled={submitting}
              data-attr="lease-sign-agree"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary"
            />
            <span>{LEASE_ESIGN_CONSENT_TEXT}</span>
          </label>
        </div>
      )}
    </Modal>
  );
}
