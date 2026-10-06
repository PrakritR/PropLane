"use client";

import { useRef } from "react";

/** One accept list for the composer's input and the New promotion pop-up's "Start from a file" card. */
export const PROMOTION_UPLOAD_ACCEPT = "image/*,application/pdf,.pdf";

export function PromotionUploadComposer({
  fileName,
  onPickFile,
  error = null,
}: {
  fileName: string | null;
  onPickFile: (file: File | null) => void;
  error?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={PROMOTION_UPLOAD_ACCEPT}
        className="hidden"
        data-attr="promotion-upload-input"
        onChange={(e) => {
          onPickFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      {fileName ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{fileName}</p>
          <button
            type="button"
            className="text-xs font-semibold text-primary hover:underline"
            onClick={() => inputRef.current?.click()}
          >
            Replace
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-accent/20 px-4 py-10 text-center transition hover:border-primary/40"
          onClick={() => inputRef.current?.click()}
        >
          <span className="text-sm font-semibold text-foreground">Drop or click to upload</span>
          <span className="text-xs text-muted">JPG, PNG, or PDF · up to 12 MB</span>
        </button>
      )}
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
