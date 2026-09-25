"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { DEMO_LEASE_SIGN_PREPARE_EVENT } from "@/lib/demo/demo-playback";
import { LEASE_ESIGN_CONSENT_TEXT, LEASE_ESIGN_CONSENT_VERSION } from "@/lib/lease-execution-evidence";
import { effectiveLeaseDocumentMode } from "@/lib/lease-execution-evidence";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { rasterizeLeasePdfPages, type RasterPage } from "@/lib/pdf-page-raster.client";
import { leaseDocumentFieldLabel, type LeaseDocumentField } from "@/lib/lease-document-library";
import { cn } from "@/lib/utils";

const FIELD_TONE: Record<LeaseDocumentField["role"], string> = {
  resident: "border-blue-500 bg-blue-500/20",
  manager: "border-amber-500 bg-amber-500/20",
};

/**
 * "Where you're signing" (night/custom-lease, item 3) — only rendered when
 * the uploaded lease carries placed signature fields
 * (`row.managerUploadedPdf.fields`). Read-only page thumbnails with each
 * placed field highlighted, so a signer sees where their signature/initials/
 * date will land before they type their name below. Absent fields (today's
 * default upload) render nothing extra here — unchanged behavior.
 */
function LeaseSigningFieldPreview({ dataUrl, fields }: { dataUrl: string; fields: LeaseDocumentField[] }) {
  const [pages, setPages] = useState<RasterPage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const revoke = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const collected: RasterPage[] = [];
    setLoaded(false);
    void rasterizeLeasePdfPages(
      dataUrl,
      (page, index) => {
        if (cancelled) return;
        collected[index] = page;
        revoke.current.push(page.url);
        setPages([...collected]);
      },
      () => cancelled,
    ).finally(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
      for (const url of revoke.current) URL.revokeObjectURL(url);
      revoke.current = [];
    };
  }, [dataUrl]);

  const pagesWithFields = useMemo(() => {
    const pageIndexes = new Set(fields.map((f) => f.page));
    return pages.map((page, index) => ({ page, index })).filter((p) => pageIndexes.has(p.index));
  }, [pages, fields]);

  return (
    <div className="rounded-xl border border-border bg-accent/20 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Where you&apos;re signing</p>
      {!loaded && pages.length === 0 ? (
        <p className="text-xs text-muted">Loading document…</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {(pagesWithFields.length > 0 ? pagesWithFields : pages.map((page, index) => ({ page, index }))).map(({ page, index }) => (
            <div key={index} className="relative w-28 shrink-0 overflow-hidden rounded border border-border bg-white shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={page.url} alt={`Page ${index + 1}`} className="block w-full" />
              {fields
                .filter((f) => f.page === index)
                .map((field) => (
                  <div
                    key={field.id}
                    className={cn("absolute rounded-sm border-2", FIELD_TONE[field.role])}
                    style={{
                      left: `${field.x * 100}%`,
                      top: `${field.y * 100}%`,
                      width: `${field.w * 100}%`,
                      height: `${field.h * 100}%`,
                    }}
                    title={leaseDocumentFieldLabel(field)}
                  />
                ))}
              <span className="absolute bottom-0.5 right-1 text-[9px] font-semibold text-muted">{index + 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Which document the signer is agreeing to, so consent cannot outlive it.
 *
 * The resident already read the lease on the page behind this dialog (PRP-416
 * removed the in-dialog viewer). Consent still binds to the current document
 * identity: a manager re-upload or regenerate while the affirmation is ticked
 * must clear the box. `lease-execution-evidence.ts` hashes whatever is current
 * AT signature time.
 *
 * Identity is deliberately narrow: only fields that change WHICH document is
 * signed. Widening it to the whole row would clear the box on every background
 * sync that appended a thread message.
 */
function signedDocumentSubject(row: LeasePipelineRow): string {
  return [
    effectiveLeaseDocumentMode(row),
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
  // never accepted with the old consent still ticked. Skipped once `signed` is
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
      {signed ? (
        <div className="rounded-2xl border px-5 py-5 text-center portal-banner-success">
          <p className="text-2xl font-black text-emerald-700">✓ Signed</p>
          <p className="mt-2 text-sm text-muted">Your electronic signature has been recorded. Closing this window…</p>
        </div>
      ) : (
        <div className="space-y-4">
          {row.managerUploadedPdf?.fields?.length && row.managerUploadedPdf.originalDataUrl ? (
            <LeaseSigningFieldPreview dataUrl={row.managerUploadedPdf.originalDataUrl} fields={row.managerUploadedPdf.fields} />
          ) : null}
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
