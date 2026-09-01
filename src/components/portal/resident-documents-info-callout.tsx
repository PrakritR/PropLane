"use client";

import { FileText, X } from "lucide-react";

/** Documents list tabs — landlord may still be filing paperwork. */
export function ResidentDocumentsInfoCallout({
  onDismiss,
}: {
  onDismiss?: () => void;
}) {
  return (
    <div
      className="mb-3 flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/10 px-3 py-2.5 text-sm leading-snug text-foreground sm:mb-4 sm:px-4 sm:py-3"
      data-attr="resident-documents-info-callout"
    >
      <FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1">
        Don&apos;t see your documents? Your landlord might still be uploading them. Check back in a bit!
      </p>
      {onDismiss ? (
        <button
          type="button"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-primary/10 hover:text-foreground"
          aria-label="Dismiss"
          data-attr="resident-documents-info-dismiss"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
