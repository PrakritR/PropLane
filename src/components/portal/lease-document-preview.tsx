"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";
import { getLeaseDocumentHtml, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { buildAiGeneratedLeaseHtml, leaseContextFromApplication } from "@/lib/generated-lease";

type Props = {
  row: LeasePipelineRow;
  /** Shown when there is no PDF and no generated HTML */
  emptyHint?: string;
  /** When true, do not render a synthetic draft from application answers (manual add-resident). */
  suppressApplicationDraft?: boolean;
  className?: string;
  /** Fixed-height, non-scrollable peek for modal chrome (full doc stays on the page behind). */
  peek?: boolean;
  /** Fill the parent flex area with a scrollable document frame (lease edit modal). */
  fill?: boolean;
  /** Grow to fill the parent while keeping the lease document label (lease pipeline detail). */
  stretch?: boolean;
  /**
   * Expand with the document on the page scroll — no nested document frame scroll
   * (resident profile lease tab).
   */
  flow?: boolean;
};

function draftHtmlFromApplication(application: Partial<RentalWizardFormState> | undefined): string | null {
  if (!application || !Object.keys(application).length) return null;
  try {
    const outcome = buildAiGeneratedLeaseHtml(leaseContextFromApplication(application as RentalWizardFormState));
    return outcome.kind === "generated" ? outcome.html : null;
  } catch {
    return null;
  }
}

function AutoHeightLeaseHtmlFrame({ srcDoc, title }: { srcDoc: string; title: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let resizeObserver: ResizeObserver | null = null;

    const measure = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc?.body) return;
        const next = Math.max(
          doc.documentElement.scrollHeight,
          doc.body.scrollHeight,
          doc.documentElement.offsetHeight,
          320,
        );
        setHeight(next);
      } catch {
        /* sandboxed */
      }
    };

    const onLoad = () => {
      measure();
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      resizeObserver = new ResizeObserver(measure);
      resizeObserver.observe(doc.body);
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      resizeObserver?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      title={title}
      srcDoc={srcDoc}
      sandbox=""
      scrolling="no"
      className="block w-full border-0 bg-card"
      style={{ height }}
    />
  );
}

/**
 * Preview of uploaded PDF, saved generated HTML, or a read-only draft built from application data.
 */
export function LeaseDocumentPreview({
  row,
  emptyHint,
  suppressApplicationDraft,
  className,
  peek = false,
  fill = false,
  stretch = false,
  flow = false,
}: Props) {
  const pdfSrc = row.managerUploadedPdf?.dataUrl ?? null;
  const html = getLeaseDocumentHtml(row);
  const defaultEmpty =
    emptyHint ??
    "No lease document yet. Click Generate lease (from application data) or upload a PDF to preview it here.";

  const syntheticHtml = useMemo(() => {
    if (suppressApplicationDraft || pdfSrc || html || row.leaseDocumentRemovedAt) return null;
    return draftHtmlFromApplication(row.application ?? undefined);
  }, [pdfSrc, html, row.application, row.leaseDocumentRemovedAt, suppressApplicationDraft]);

  const showSynthetic = Boolean(syntheticHtml);
  const previewHtml = html ?? syntheticHtml;
  const flexibleHeight = (fill || stretch) && !flow;
  const frameClass = flexibleHeight
    ? "absolute inset-0 h-full w-full border-0 bg-card"
    : peek
      ? "h-[7.25rem] w-full bg-card pointer-events-none sm:h-[8.5rem]"
      : "h-[min(52vh,420px)] w-full bg-card";
  const emptyClass = flow
    ? "flex min-h-[12rem] items-center justify-center px-4 py-10 text-center text-sm text-muted"
    : flexibleHeight
      ? "flex min-h-[12rem] flex-1 items-center justify-center px-4 text-center text-sm text-muted"
      : peek
        ? "flex h-[7.25rem] items-center justify-center px-4 text-center text-sm text-muted sm:h-[8.5rem]"
        : "flex h-[min(36vh,280px)] items-center justify-center px-4 text-center text-sm text-muted";
  const frameScroll = peek || flow ? "no" : "yes";

  return (
    <div
      className={`mt-4 overflow-hidden rounded-2xl border border-border bg-accent/30 ${peek || flexibleHeight || flow ? "mt-0" : ""} ${flexibleHeight ? "flex flex-1 flex-col" : ""} ${className ?? ""}`}
    >
      {!fill ? (
        <p className="border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
          Lease document
        </p>
      ) : null}
      {showSynthetic ? (
        <p className="border-b px-3 py-2 text-xs portal-banner-info">
          Draft preview from saved application answers. Use Generate to save a version to the pipeline, or upload a PDF.
        </p>
      ) : null}
      {pdfSrc ? (
        <div className={flexibleHeight ? "relative flex min-h-0 flex-1 flex-col" : undefined}>
          {(row.residentSignature || row.managerSignature) && row.managerUploadedPdf?.dataUrl ? (
            <p className="shrink-0 border-b px-3 py-2 text-xs portal-banner-success">
              Signature certificate page appended to this PDF.
            </p>
          ) : null}
          <UploadedLeasePdfPreview
            dataUrl={pdfSrc}
            title="Lease PDF preview"
            fileName={row.managerUploadedPdf?.fileName}
            embeddedInFlex={flexibleHeight}
            documentFlow={flow}
            className={flexibleHeight ? "flex min-h-0 flex-1 flex-col" : undefined}
          />
        </div>
      ) : previewHtml ? (
        <div className={flexibleHeight ? "relative flex min-h-0 flex-1 flex-col" : undefined}>
          {flow ? (
            <AutoHeightLeaseHtmlFrame srcDoc={previewHtml} title="Lease document" />
          ) : (
            <div className={flexibleHeight ? "relative min-h-0 flex-1 overflow-hidden" : undefined}>
              <iframe
                title="Lease document"
                srcDoc={previewHtml}
                sandbox=""
                scrolling={frameScroll}
                className={frameClass}
              />
            </div>
          )}
        </div>
      ) : syntheticHtml ? (
        <div className={flexibleHeight ? "relative flex min-h-0 flex-1 flex-col" : undefined}>
          {flow ? (
            <AutoHeightLeaseHtmlFrame srcDoc={syntheticHtml} title="Lease draft preview" />
          ) : (
            <div className={flexibleHeight ? "relative min-h-0 flex-1 overflow-hidden" : undefined}>
              <iframe
                title="Lease draft preview"
                srcDoc={syntheticHtml}
                sandbox=""
                scrolling={frameScroll}
                className={frameClass}
              />
            </div>
          )}
        </div>
      ) : (
        <div className={emptyClass}>
          {defaultEmpty}
        </div>
      )}
    </div>
  );
}
