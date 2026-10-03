"use client";

/**
 * Step 1 of `/portal/properties/import` — pick a rent roll, an AppFolio /
 * Buildium export, or lease PDFs and hand them to the one model read that
 * returns a `PortfolioImportProposal` (properties, current residents,
 * charges, tasks — see `src/lib/portfolio-import/types.ts`). This step only
 * collects files and an optional hint; the server does the reading.
 */

import { useState } from "react";
import { FileSpreadsheet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspaceUploadAction } from "@/components/portal/add-workspace/upload-action";

const ACCEPT = ".xlsx,.xls,.csv,.pdf";
const MAX_FILES = 50;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PortfolioImportUploadStep({
  uploading,
  error,
  onSubmit,
  onBack,
}: {
  uploading: boolean;
  error: string | null;
  onSubmit: (files: File[], hint: string) => void;
  onBack: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [hint, setHint] = useState("");
  const [rejected, setRejected] = useState<string | null>(null);

  // Limits are named only when a file is turned away — no format chips ahead of time.
  const addFiles = (picked: FileList | File[]) => {
    const next = [...files];
    let turnedAway: string | null = null;
    for (const file of Array.from(picked)) {
      if (!/\.(xlsx|xls|csv|pdf)$/i.test(file.name)) {
        turnedAway = `${file.name} is not a spreadsheet or PDF. Use .xlsx, .xls, .csv or .pdf.`;
        continue;
      }
      if (next.length >= MAX_FILES) {
        turnedAway = `Up to ${MAX_FILES} files at a time.`;
        break;
      }
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
      next.push(file);
    }
    setRejected(turnedAway);
    setFiles(next);
  };

  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-0">
      <div className="mb-1 flex items-center gap-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to Properties"
          data-attr="portfolio-import-back"
          className="-ml-1 flex min-h-8 items-center gap-0.5 rounded-lg px-1 text-sm font-medium text-primary hover:bg-accent/40"
        >
          <span aria-hidden>‹</span>
          <span>Properties</span>
        </button>
      </div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-[20px] font-bold tracking-tight text-foreground md:text-[22px]">Import your portfolio</h1>
        <WorkspaceUploadAction
          accept={ACCEPT}
          onPick={(file) => {
            setRejected(null);
            addFiles([file]);
          }}
          disabled={uploading}
          dataAttr="portfolio-import-upload"
          inputDataAttr="portfolio-import-file-input"
        />
      </div>
      {rejected ? (
        <p role="alert" data-attr="portfolio-import-rejected" className="mb-3 text-[13px] font-semibold text-destructive">
          {rejected}
        </p>
      ) : null}

      <div className="mb-1 text-[12.5px] font-bold text-foreground">Files</div>
      {files.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-3 py-3 text-[14px] text-muted" data-attr="portfolio-import-no-files">
          No files yet
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className="flex flex-col gap-1.5" data-attr="portfolio-import-file-list">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${index}`}
              className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2"
            >
              <FileSpreadsheet className="size-4 shrink-0 text-muted" strokeWidth={1.6} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{file.name}</span>
              <span className="shrink-0 text-[12px] text-muted">{formatFileSize(file.size)}</span>
              <button
                type="button"
                onClick={() => removeFile(index)}
                aria-label={`Remove ${file.name}`}
                data-attr="portfolio-import-file-remove"
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5">
        <label htmlFor="portfolio-import-hint" className="mb-1.5 block text-[13px] font-semibold text-foreground">
          Anything PropLane should know?
        </label>
        <input
          id="portfolio-import-hint"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="AppFolio export, 2 buildings"
          data-attr="portfolio-import-hint"
          className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-[14px] text-foreground outline-none focus:border-primary"
        />
      </div>

      {error ? (
        <p role="alert" data-attr="portfolio-import-error" className="mt-5 rounded-2xl border px-4 py-3 text-sm portal-banner-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex justify-end">
        <Button
          variant="primary"
          disabled={files.length === 0}
          loading={uploading}
          data-attr="portfolio-import-read-files"
          onClick={() => onSubmit(files, hint)}
        >
          Read files
        </Button>
      </div>
    </div>
  );
}
