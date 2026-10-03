"use client";

import { useMemo } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AutoHeightLeaseHtmlFrame } from "@/components/portal/lease-document-preview";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { resolvePropertyLeaseEditHtml } from "@/lib/property-lease-edit";
import type { PropertyLeasePreviewHint } from "@/lib/property-lease-preview";
import { propertyLeaseSourceFromTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";

export function PropertyLeaseTemplateInlinePreview({
  template,
  sub,
  propertyHint,
  onBack,
  solo = false,
}: {
  template: PropertyLeaseTemplate;
  sub: ManagerListingSubmissionV1;
  propertyHint?: PropertyLeasePreviewHint;
  onBack?: () => void;
  /** Solo tab — no back chevron (replica ps40.newTab). */
  solo?: boolean;
}) {
  const source = propertyLeaseSourceFromTemplate(template);
  const html = useMemo(
    () =>
      resolvePropertyLeaseEditHtml({
        sub,
        draft: template,
        source,
        templateKind: template.kind,
        hint: propertyHint,
      }),
    [sub, template, source, propertyHint],
  );

  const pdfUrl = template.leaseTemplateDocUrl?.trim() || null;
  const showPdf = source === "custom_format" && pdfUrl && !html.trim();

  return (
    <div className="space-y-3" data-attr="property-lease-inline-preview" data-ps40-page="lease-view">
      {!solo && onBack ? (
        <Button
          type="button"
          variant="ghost"
          className="ps40-back -ml-2 h-11 gap-1 px-2 text-sm font-semibold"
          data-attr="property-lease-preview-back"
          onClick={onBack}
        >
          <ChevronLeft className="size-5" aria-hidden />
          Back
        </Button>
      ) : null}
      <p className="text-base font-semibold text-foreground">{template.label}</p>
      {showPdf && pdfUrl ? (
        <UploadedLeasePdfPreview
          dataUrl={pdfUrl}
          title={template.leaseTemplateDocName || template.label}
          fileName={template.leaseTemplateDocName || "lease.pdf"}
        />
      ) : html.trim() ? (
        // The one lease frame every surface draws (the lease record, Send lease, the resident record):
        // the property's lease reads exactly like the lease it makes, with its placement fields unfilled.
        <div
          className="overflow-hidden rounded-2xl border border-border bg-card"
          data-attr="property-lease-inline-preview-document"
        >
          <AutoHeightLeaseHtmlFrame srcDoc={html} title={template.label || "Lease document"} />
        </div>
      ) : (
        <p className="text-sm text-muted">No lease document yet.</p>
      )}
    </div>
  );
}
