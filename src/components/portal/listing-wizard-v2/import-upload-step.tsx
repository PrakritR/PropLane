"use client";

/**
 * The Upload step — the one step Import properties has that Add property
 * does not. Four states: pick a file → PropLane is reading it → here is
 * what it found → it couldn't read it. Once something is found, every
 * property is already a draft; this screen is the table of contents.
 */

import { useRef, useState, type ReactNode } from "react";
import { FileSpreadsheet, MoreHorizontal, Upload } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { importReadinessLabel } from "@/components/portal/listing-wizard-v2/import-property-switcher";
import { describeSourceRows, importedMonthlyRent } from "@/lib/property-import/to-submission";
import { PROPERTY_IMPORT_MAX_BYTES, type PropertyImportProperty, type PropertyImportUnderstanding } from "@/lib/property-import/types";
import { cn } from "@/lib/utils";

export const IMPORT_FILE_ACCEPT =
  ".xlsx,.xls,.csv,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/pdf";

export type ImportReadState =
  | { kind: "empty" }
  | { kind: "reading"; fileName: string }
  | { kind: "found"; understanding: PropertyImportUnderstanding }
  | { kind: "error"; fileName: string | null; message: string };

/** One property row on the Found list — the understood property plus whether its draft exists yet. */
export type ImportFoundEntry = {
  key: string;
  property: PropertyImportProperty;
  saving: boolean;
  /** Why the draft could not be written, in the server's words; null once it saved. */
  saveError?: string | null;
};

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

function propertyDetailLine(p: PropertyImportProperty): string {
  const where = [p.city, p.state].filter(Boolean).join(", ");
  const model = p.rentByRoom || p.rooms.filter((r) => r.rent != null).length >= 2 ? "By the room" : "Whole place";
  const count = p.rooms.length > 0 ? `${p.rooms.length} ${p.rentByRoom ? "room" : "unit"}${p.rooms.length === 1 ? "" : "s"}` : `${p.bedrooms} bed`;
  const rent = importedMonthlyRent(p);
  const rows = describeSourceRows(p.sourceRows);
  return [where, model, count, rent != null ? `${usd(rent)}/mo` : null, rows].filter(Boolean).join(" · ");
}

/** What the "Start from a file" strip is showing. `confirm` is a file picked while Basics already holds typed work. */
export type ImportStripState =
  | { kind: "blank" }
  | { kind: "reading"; fileName: string }
  | { kind: "error"; fileName: string | null; message: string }
  | { kind: "confirm"; fileName: string };

const FORMAT_CHIPS = [".xlsx", ".csv", ".pdf rent roll", "AppFolio export", "Buildium export", `up to ${Math.round(PROPERTY_IMPORT_MAX_BYTES / 1024 / 1024)} MB`];

/**
 * The "Start from a file" strip — one dashed row that sits above Property type
 * on a new listing's Basics, and is the whole of the Import step until a file
 * has been read. Blank → reading → (found, drawn by ImportUploadStep) or the
 * server's own reason it could not read the file, with the hint box.
 */
export function ImportFileStrip({
  state,
  busy,
  onPickFile,
  onReread,
  onConfirm,
  onCancel,
}: {
  state: ImportStripState;
  busy: boolean;
  onPickFile: (file: File) => void;
  onReread: (hint: string) => void;
  /** The manager chose to replace what they typed with the picked file. */
  onConfirm?: () => void;
  /** The manager kept what they typed; the picked file is dropped. */
  onCancel?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [hint, setHint] = useState("");

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    onPickFile(file);
    if (fileRef.current) fileRef.current.value = "";
  };

  const input = (
    <input
      ref={fileRef}
      type="file"
      accept={IMPORT_FILE_ACCEPT}
      className="sr-only"
      onChange={(e) => pick(e.target.files)}
      data-attr="import-upload-file-input"
      aria-label="Choose a spreadsheet or PDF"
    />
  );

  const chooseButton = (label: string, dataAttr: string) => (
    <button
      type="button"
      onClick={() => fileRef.current?.click()}
      disabled={busy}
      data-attr={dataAttr}
      className="min-h-[40px] shrink-0 rounded-full border border-border bg-card px-5 text-[13.5px] font-bold text-foreground hover:bg-accent/40 disabled:opacity-50"
    >
      {label}
    </button>
  );

  if (state.kind === "blank") {
    return (
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          pick(e.dataTransfer.files);
        }}
        data-attr="create-file-strip"
        data-state="blank"
        className={cn(
          "mb-5 flex cursor-pointer flex-wrap items-center gap-3.5 rounded-2xl border-[1.5px] border-dashed px-4 py-3 transition sm:flex-nowrap",
          dragOver ? "border-primary bg-primary/[0.06]" : "border-border bg-[var(--pl-surface-muted)] hover:border-primary/50",
        )}
      >
        {input}
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-card text-[var(--pl-blue-deep)]">
          <Upload className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-bold text-foreground">Start from a file</span>
          <span className="mt-1 flex flex-wrap gap-1.5">
            {FORMAT_CHIPS.map((chip) => (
              <span key={chip} className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-bold text-muted">
                {chip}
              </span>
            ))}
          </span>
        </span>
        <span className="w-full sm:w-auto">{chooseButton("Choose file", "create-file-choose")}</span>
      </label>
    );
  }

  if (state.kind === "reading") {
    return (
      <div data-attr="create-file-strip" data-state="reading" className="mb-5 flex items-center gap-3.5 rounded-2xl border-[1.5px] border-primary bg-card px-4 py-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-card text-[var(--pl-blue-deep)]">
          <Upload className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-bold text-foreground" role="status">
            Reading {state.fileName}
          </span>
          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-accent" aria-hidden>
            <span className="block h-full w-1/3 animate-[import-read_1.6s_ease-in-out_infinite] rounded-full bg-primary" />
          </span>
          <style>{`@keyframes import-read { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }`}</style>
        </span>
      </div>
    );
  }

  if (state.kind === "confirm") {
    return (
      <div data-attr="create-file-strip" data-state="confirm" role="alertdialog" aria-label="Replace what you typed" className="mb-5 flex flex-wrap items-center gap-3.5 rounded-2xl border-[1.5px] border-primary bg-primary/[0.06] px-4 py-3">
        <span className="min-w-0 flex-1 text-[14px] font-bold text-foreground">Replace what you typed with {state.fileName}?</span>
        <span className="flex gap-2">
          <button type="button" onClick={onCancel} data-attr="create-file-keep" className="min-h-[40px] rounded-full border border-border bg-card px-5 text-[13.5px] font-bold text-foreground hover:bg-accent/40">
            Keep what I typed
          </button>
          <button type="button" onClick={onConfirm} data-attr="create-file-replace" className="min-h-[40px] rounded-full bg-primary px-5 text-[13.5px] font-bold text-white">
            Replace
          </button>
        </span>
      </div>
    );
  }

  return (
    <div data-attr="create-file-strip" data-state="error" className="mb-5 rounded-2xl border px-4 py-3 portal-banner-danger">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-bold" role="alert" data-attr="import-upload-error">
            {state.fileName ? `Couldn't read ${state.fileName}` : "Couldn't read that file"} — {state.message}
          </span>
        </span>
        {input}
        {chooseButton("Choose a different file", "import-upload-choose-again")}
      </div>
      {state.fileName ? (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!hint.trim() || busy) return;
            onReread(hint.trim());
          }}
        >
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="Tell PropLane how the sheet is laid out — e.g. “each tab is one house; the tab name is the address”"
            maxLength={600}
            disabled={busy}
            data-attr="import-upload-hint"
            className="min-h-[40px] min-w-0 flex-1 rounded-xl border border-border bg-card px-3.5 text-[13.5px] text-foreground outline-none placeholder:text-muted focus:border-primary/60"
          />
          <button
            type="submit"
            disabled={busy || !hint.trim()}
            data-attr="import-upload-reread"
            className="min-h-[40px] shrink-0 rounded-full border border-border bg-card px-5 text-[13.5px] font-bold text-foreground hover:bg-accent/40 disabled:opacity-50"
          >
            Re-read
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** The strip's view of the read state — the Import step shows the strip until something is found. */
export function stripStateFromRead(state: ImportReadState): ImportStripState | null {
  if (state.kind === "empty") return { kind: "blank" };
  if (state.kind === "reading") return { kind: "reading", fileName: state.fileName };
  if (state.kind === "error") return { kind: "error", fileName: state.fileName, message: state.message };
  return null;
}

export function ImportUploadStep({
  state,
  entries,
  onPickFile,
  onReread,
  onOpen,
  onRemove,
  onMerge,
  busy,
}: {
  state: ImportReadState;
  entries: ImportFoundEntry[];
  onPickFile: (file: File) => void;
  onReread: (hint: string) => void;
  onOpen: (key: string) => void;
  onRemove: (key: string) => void;
  /** Fold `fromKey` into `intoKey` — two rows that were one house. */
  onMerge: (fromKey: string, intoKey: string) => void;
  busy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState("");

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    onPickFile(file);
    if (fileRef.current) fileRef.current.value = "";
  };

  const input = (
    <input
      ref={fileRef}
      type="file"
      accept={IMPORT_FILE_ACCEPT}
      className="sr-only"
      onChange={(e) => pick(e.target.files)}
      data-attr="import-upload-file-input"
      aria-label="Choose a spreadsheet or PDF"
    />
  );

  const hintBox = (placeholder: string) => (
    <form
      className="mt-3 flex flex-col gap-2 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (!hint.trim() || busy) return;
        onReread(hint.trim());
      }}
    >
      <input
        value={hint}
        onChange={(e) => setHint(e.target.value)}
        placeholder={placeholder}
        maxLength={600}
        disabled={busy}
        data-attr="import-upload-hint"
        className="min-h-[42px] min-w-0 flex-1 rounded-xl border border-border bg-card px-3.5 text-[13.5px] text-foreground outline-none placeholder:text-muted focus:border-primary/60"
      />
      <button
        type="submit"
        disabled={busy || !hint.trim()}
        data-attr="import-upload-reread"
        className="min-h-[42px] shrink-0 rounded-full border border-border bg-card px-5 text-[13.5px] font-bold text-foreground hover:bg-accent/40 disabled:opacity-50"
      >
        Re-read
      </button>
    </form>
  );

  if (state.kind !== "found") {
    const strip = stripStateFromRead(state) ?? { kind: "blank" as const };
    return (
      <div data-attr="import-upload-step" data-state={state.kind}>
        <StepHeading title={state.kind === "reading" ? `Reading ${state.fileName}` : state.kind === "error" ? "Couldn't read this file" : "Start from a file"} />
        <ImportFileStrip state={strip} busy={busy} onPickFile={onPickFile} onReread={onReread} />
      </div>
    );
  }

  const u = state.understanding;
  const found = entries.length;
  const rooms = entries.reduce((n, e) => n + e.property.rooms.length, 0);
  const rentTotal = entries.reduce((n, e) => n + (importedMonthlyRent(e.property) ?? 0), 0);
  const needLook = entries.filter((e) => e.property.needsLook.length > 0).length;

  return (
    <div data-attr="import-upload-step" data-state="found">
      <StepHeading title={found === 0 ? "No properties found" : `Found ${found} propert${found === 1 ? "y" : "ies"}`} />

      {found > 0 ? (
        <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4" data-attr="import-upload-stats">
          <Stat value={String(found)} label={found === 1 ? "property" : "properties"} />
          <Stat value={String(rooms)} label="rooms & units" />
          <Stat value={rentTotal > 0 ? usd(rentTotal) : "—"} label="monthly rent read" />
          <Stat value={String(needLook)} label="need a look" warn={needLook > 0} />
        </div>
      ) : null}

      <ul className="mb-4 flex flex-col gap-2" data-attr="import-found-list">
        {entries.map((entry) => {
          const p = entry.property;
          const ready = p.needsLook.length === 0;
          return (
            <li key={entry.key}>
              <div
                className="flex items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 transition hover:border-primary/40"
                data-attr="import-found-row"
              >
                <button
                  type="button"
                  onClick={() => onOpen(entry.key)}
                  disabled={entry.saving}
                  data-attr="import-found-open"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-60"
                >
                  <span className="grid h-10 w-12 shrink-0 place-items-center rounded-lg bg-accent text-muted">
                    <FileSpreadsheet className="h-5 w-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-bold text-foreground">
                      {p.name && p.name !== p.address ? `${p.name} · ${p.address}` : p.address || p.name}
                      {p.zip ? `, ${p.zip}` : ""}
                    </span>
                    <span className={cn("block truncate text-[12.5px]", entry.saveError ? "text-[var(--status-overdue-fg)]" : "text-muted")}>
                      {entry.saving ? "Saving draft…" : entry.saveError ? `Not saved — ${entry.saveError}` : propertyDetailLine(p)}
                    </span>
                  </span>
                </button>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold",
                    ready ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]" : "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
                  )}
                  title={p.needsLook.join(" · ")}
                >
                  {importReadinessLabel(p.needsLook)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    type="button"
                    aria-label={`Actions for ${p.name || p.address}`}
                    data-attr="import-found-actions"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted hover:bg-accent/60 hover:text-foreground"
                  >
                    <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onOpen(entry.key)} data-attr="import-found-action-open">
                      Open
                    </DropdownMenuItem>
                    {entries.length > 1 ? (
                      <>
                        <DropdownMenuSeparator />
                        {entries
                          .filter((other) => other.key !== entry.key)
                          .slice(0, 8)
                          .map((other) => (
                            <DropdownMenuItem key={other.key} onSelect={() => onMerge(entry.key, other.key)} data-attr="import-found-action-merge">
                              Merge into {other.property.name || other.property.address}
                            </DropdownMenuItem>
                          ))}
                      </>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onRemove(entry.key)} className="text-danger" data-attr="import-found-action-remove">
                      Not a property
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          );
        })}
      </ul>

      <section className="rounded-2xl border border-border bg-[var(--pl-surface-muted)] px-4 py-3.5" data-attr="import-understood">
        <h3 className="mb-2 text-[13.5px] font-bold text-foreground">What PropLane understood</h3>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-foreground/80">
          {u.sheets.map((s) => (
            <li key={s.name}>
              <b className="font-semibold text-foreground">{s.name}</b> — {s.whatItIs}
              {!s.used ? " Skipped." : ""}
            </li>
          ))}
          {u.summary.map((line, i) => (
            <li key={`s-${i}`}>{line}</li>
          ))}
          {u.truncatedNote ? <li className="text-[var(--status-pending-fg)]">{u.truncatedNote}</li> : null}
        </ul>
        {hintBox("Tell it something it missed — e.g. “Sheet 3 column F is the deposit”")}
      </section>

      <div className="mt-4 flex flex-wrap gap-2">
        {input}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          data-attr="import-upload-choose-other"
          className="min-h-[42px] rounded-full border border-border bg-card px-5 text-[13.5px] font-bold text-foreground hover:bg-accent/40 disabled:opacity-50"
        >
          Choose a different file
        </button>
      </div>
    </div>
  );
}

function Stat({ value, label, warn = false }: { value: string; label: string; warn?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-3.5 py-2.5">
      <b className={cn("block text-[22px] font-bold leading-tight tracking-tight", warn ? "text-[var(--status-pending-fg)]" : "text-foreground")}>{value}</b>
      <span className="text-[12px] text-muted">{label}</span>
    </div>
  );
}

/** The right-hand panel while the manager is on Upload. */
export function ImportUploadSidePanel({ state, draftCount }: { state: ImportReadState; draftCount: number }): ReactNode {
  const rows: Array<[string, string]> = [];
  if (state.kind === "found") {
    const u = state.understanding;
    rows.push(["File", u.fileName]);
    rows.push(["Sheets", String(u.sheets.length)]);
    rows.push(["Rows read", u.rowsRead.toLocaleString("en-US")]);
    rows.push(["Properties", String(draftCount)]);
  } else if (state.kind === "reading") {
    rows.push(["File", state.fileName]);
  }
  return (
    <section className="rounded-2xl border border-border bg-card p-3.5" data-attr="import-upload-side">
      <h3 className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">Your file</h3>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">No file yet</p>
      ) : (
        <dl className="text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3 border-b border-dashed border-border py-1.5 last:border-b-0">
              <dt className="text-muted">{k}</dt>
              <dd className="min-w-0 truncate font-semibold text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
