"use client";

import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";
import { PropertyLeaseClausePaperEditor } from "@/components/portal/property-lease-clause-paper-editor";
import { parseLeaseHtmlSections } from "@/lib/lease-html-sections";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";

/**
 * The lease document body editor: the clause-by-clause paper when the document has clauses, else the
 * whole-document editor. The lease form modal's Document step and the listing editor's inline Lease
 * step both draw this one component, so a clause edit looks and saves the same in either.
 */
export function PropertyLeaseDocumentEditor({
  html,
  baselineHtml,
  onChange,
  className,
  detectedFieldCount,
}: {
  html: string;
  /** The generated document the whole-document editor diffs against (the review notice is stripped here). */
  baselineHtml: string;
  onChange: (html: string) => void;
  className?: string;
  detectedFieldCount?: number;
}) {
  return parseLeaseHtmlSections(html).some((section) => section.id !== "lease-document-header") ? (
    <PropertyLeaseClausePaperEditor className={className} html={html} detectedFieldCount={detectedFieldCount} onChange={onChange} />
  ) : (
    <LeaseHtmlDirectEditor
      className={className}
      html={html}
      baselineHtml={stripDisclosureReviewFromLeaseHtml(baselineHtml)}
      onChange={onChange}
      showPersistBar={false}
    />
  );
}
