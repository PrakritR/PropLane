"use client";

/**
 * Step 1 of `/portal/properties/import` — pick a rent roll, an AppFolio /
 * Buildium export, or lease PDFs and hand them to the one model read that
 * returns a `PortfolioImportProposal` (properties, current residents,
 * charges, tasks — see `src/lib/portfolio-import/types.ts`). This step only
 * collects files and an optional hint; the server does the reading.
 */

import { useRef, useState, type DragEvent } from "react";
import {
  FileSpreadsheet,
  FileText,
  Home,
  ListChecks,
  Receipt,
  Table,
  Upload,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { cn } from "@/lib/utils";

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
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (picked: FileList | File[]) => {
    const next = [...files];
    for (const file of Array.from(picked)) {
      if (next.length >= MAX_FILES) break;
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
      next.push(file);
    }
    setFiles(next);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
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
      <h1 className="mb-3 text-[20px] font-bold tracking-tight text-foreground md:text-[22px]">Import your portfolio</h1>

      <p className="mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-foreground/70" data-attr="portfolio-import-file-kinds">
        <PortalRowFact icon={FileSpreadsheet}>Spreadsheet</PortalRowFact>
        <span aria-hidden>·</span>
        <PortalRowFact icon={Table}>AppFolio / Buildium export</PortalRowFact>
        <span aria-hidden>·</span>
        <PortalRowFact icon={FileText}>Lease PDFs</PortalRowFact>
      </p>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          e.target.value = "";
        }}
        data-attr="portfolio-import-file-input"
      />
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        data-attr="portfolio-import-dropzone"
        className={cn(
          "flex min-h-[168px] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center outline-none transition-colors",
          dragOver ? "border-primary bg-primary/[0.05]" : "border-border hover:border-primary/40",
        )}
      >
        <Upload className="size-6 text-muted" strokeWidth={1.6} aria-hidden />
        <p className="text-[15px] font-semibold text-foreground">Drop files here</p>
        <p className="text-[12.5px] text-muted">.xlsx · .csv · .pdf · up to {MAX_FILES} files</p>
      </div>

      {files.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5" data-attr="portfolio-import-file-list">
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

      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2" data-attr="portfolio-import-value-facts">
        <p className="flex items-start gap-2 text-[13px] text-foreground/70">
          <Home className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} aria-hidden />
          <span>Properties &amp; rooms, from the rent roll</span>
        </p>
        <p className="flex items-start gap-2 text-[13px] text-foreground/70">
          <Users className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} aria-hidden />
          <span>Residents &amp; leases — names, dates, rent</span>
        </p>
        <p className="flex items-start gap-2 text-[13px] text-foreground/70">
          <Receipt className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} aria-hidden />
          <span>Charges — current balances</span>
        </p>
        <p className="flex items-start gap-2 text-[13px] text-foreground/70">
          <ListChecks className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} aria-hidden />
          <span>Tasks &amp; invites — what to do next</span>
        </p>
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
