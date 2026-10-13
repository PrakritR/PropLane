"use client";

import { createContext, useContext, useRef, useState, type ChangeEvent, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Camera, ScanLine, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { scanImageToPdf } from "./scan-document";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

/** File readers retain ownership of parsing and limits; only the picker moves to chrome. */
export const WorkspaceUploadTarget = createContext<HTMLElement | null>(null);

/**
 * True when the pop-up itself draws the ONE "Start from a file" card (`AddWorkspace`'s
 * `headerUpload`, rendered at the top of the first step). A step's own file strip then keeps its
 * reading / replace-confirm / filled states but draws no second card in the blank state.
 */
export const WorkspaceHeaderUploadPresent = createContext(false);

/** One more door on the "Start from a file" card — another way to bring a file in (e.g. a whole-portfolio import). */
export type WorkspaceUploadExtraItem = {
  label: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  onSelect: () => void;
  dataAttr?: string;
};

export type WorkspaceHeaderUploadProps = {
  accept: string;
  onPick: (file: File) => void;
  disabled?: boolean;
  dataAttr?: string;
  /** Names the file input for assistive tech; the card's visible title is always "Start from a file". */
  label?: string;
  extraItems?: WorkspaceUploadExtraItem[];
};

/** True when `file` matches an `accept` list (MIME types, `type/*` wildcards and extensions). An empty list accepts anything. */
export function fileMatchesAccept(file: Pick<File, "name" | "type">, accept: string): boolean {
  const parts = accept.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return parts.some((part) => {
    if (part.startsWith(".")) return name.endsWith(part);
    if (part.endsWith("/*")) return type.startsWith(part.slice(0, -1));
    return type === part;
  });
}

/**
 * The error a refused pick shows, or null when the file is fine. Size limits stay with each flow's
 * reader, which already refuses an oversize file with its own message.
 */
export function fileRefusal(file: Pick<File, "name" | "type">, accept: string): string | null {
  return fileMatchesAccept(file, accept) ? null : "That file type isn't supported.";
}

/**
 * "Start from a file" — the dashed card at the top of an Add pop-up's first step (captain, Oct 6):
 * upload icon tile, title, and a "Choose file" button. It is the pop-up's
 * one upload entry; `onPick` is that flow's existing reader.
 */
export function WorkspaceFileCard({ accept, onPick, onPickMany, fileName, inputDataAttr, disabled, dataAttr = "workspace-header-upload", label = "Start from a file", extraItems, className }: WorkspaceHeaderUploadProps & {
  className?: string;
  /** The upload IS the record (Add document): the card takes several files at once and hands them all here. */
  onPickMany?: (files: File[]) => void;
  /** The file already chosen — shown under the title in place of nothing, so the card doubles as the filled state. */
  fileName?: string | null;
  /** Overrides the file input's `data-attr` (defaults to `<dataAttr>-input`). */
  inputDataAttr?: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const acceptsPdf = /(?:application\/pdf|\.pdf)(?:,|$)/i.test(accept);
  const acceptsImages = accept.split(",").some((part) => /^(image\/|\.(png|jpe?g|heic|webp)$)/i.test(part.trim()));
  const canCapture = acceptsImages || acceptsPdf;
  const off = Boolean(disabled);
  /** A wrong type or an oversize file is refused here, with a visible error, before the flow's reader sees it. */
  const accepts = (file: File) => {
    const refusal = fileRefusal(file, accept);
    setScanError(refusal);
    return refusal === null;
  };
  const acceptMany = (files: File[]) => {
    const refusals = files.map((file) => fileRefusal(file, accept));
    setScanError(refusals.find((refusal) => refusal !== null) ?? null);
    return files.filter((_, index) => refusals[index] === null);
  };
  const capture = async (file: File) => {
    setScanError(null);
    setScanning(true);
    try { onPick(acceptsPdf ? await scanImageToPdf(file) : file); }
    catch (error) { setScanError(error instanceof Error ? error.message : "Could not scan the document."); }
    finally { setScanning(false); }
  };
  const take = (event: ChangeEvent<HTMLInputElement>, asScan: boolean) => {
    const file = event.target.files?.[0];
    if (file && !off) { if (asScan || !acceptsImages) void capture(file); else if (accepts(file)) onPick(file); }
    event.target.value = "";
  };
  const button = "min-h-[40px] rounded-full border border-border bg-card px-5 text-[13.5px] font-bold text-foreground hover:bg-accent/40 disabled:opacity-50";
  return (
    <div
      data-attr={dataAttr}
      data-state={fileName ? "filled" : "blank"}
      onDragOver={(event) => { event.preventDefault(); if (!off) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (off) return;
        if (onPickMany) { const files = acceptMany(Array.from(event.dataTransfer.files ?? [])); if (files.length) onPickMany(files); return; }
        const file = event.dataTransfer.files?.[0];
        if (file && accepts(file)) onPick(file);
      }}
      className={cn(
        "mb-5 flex flex-wrap items-center gap-3.5 rounded-2xl border-[1.5px] border-dashed px-4 py-3 transition sm:flex-nowrap",
        dragOver ? "border-primary bg-primary/[0.06]" : "border-border bg-[var(--pl-surface-muted)]",
        off && "opacity-60",
        className,
      )}
    >
      <input ref={fileRef} type="file" accept={accept || undefined} multiple={Boolean(onPickMany)} className="sr-only" aria-label={label} disabled={off} data-attr={inputDataAttr ?? `${dataAttr}-input`} onChange={(event) => {
        if (!off) {
          if (onPickMany) { const files = acceptMany(Array.from(event.target.files ?? [])); if (files.length) onPickMany(files); }
          else { const file = event.target.files?.[0]; if (file && accepts(file)) onPick(file); }
        }
        event.target.value = "";
      }} />
      {canCapture ? <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take photo" disabled={off} onChange={(event) => take(event, false)} /> : null}
      {canCapture ? <input ref={scanRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Scan document" disabled={off || scanning} onChange={(event) => take(event, true)} /> : null}
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border bg-card text-[var(--pl-blue-deep)]">
        <Upload className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-bold text-foreground">Start from a file</span>
        {fileName ? <span className="mt-1 block truncate text-[12.5px] font-semibold text-foreground" data-attr={`${dataAttr}-file-name`}>{fileName}</span> : null}
        {scanError ? <span role="alert" className="mt-1 block text-[12px] font-semibold text-destructive">{scanError}</span> : null}
      </span>
      <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
        {canCapture ? <button type="button" disabled={off || scanning} onClick={() => cameraRef.current?.click()} className={cn(button, "md:hidden")}><Camera className="mr-1.5 inline size-4" aria-hidden />Take photo</button> : null}
        {acceptsPdf ? <button type="button" disabled={off || scanning} onClick={() => scanRef.current?.click()} className={cn(button, "md:hidden")}><ScanLine className="mr-1.5 inline size-4" aria-hidden />Scan</button> : null}
        {extraItems?.map((item) => <button key={item.label} type="button" disabled={off} data-attr={item.dataAttr} onClick={item.onSelect} className={button}>{item.label}</button>)}
        <button type="button" disabled={off || scanning} onClick={() => fileRef.current?.click()} data-attr={`${dataAttr}-choose`} className={cn(button, "w-full sm:w-auto")}>{scanning ? "Scanning…" : fileName ? "Choose another" : "Choose file"}</button>
      </span>
    </div>
  );
}

/** Legacy single header Upload icon (Upload file · Take photo · Scan). Add pop-ups now draw `WorkspaceFileCard` instead. */
export function WorkspaceHeaderUpload({ accept, onPick, disabled, dataAttr = "workspace-header-upload", label = "Upload", extraItems }: WorkspaceHeaderUploadProps) {
  return <WorkspaceUploadAction accept={accept} onPick={onPick} disabled={disabled} dataAttr={dataAttr} inputDataAttr={`${dataAttr}-input`} label={label} extraItems={extraItems} />;
}

export function WorkspaceUploadAction({ accept, onPick, disabled, dataAttr, inputDataAttr, label = "Start from a file", inline = false, extraItems }: {
  accept: string;
  onPick: (file: File) => void;
  disabled?: boolean;
  dataAttr: string;
  inputDataAttr?: string;
  label?: string;
  /** Render in place (e.g. at a step heading's right) instead of portalling into `WorkspaceUploadTarget`. */
  inline?: boolean;
  extraItems?: WorkspaceUploadExtraItem[];
}) {
  const target = useContext(WorkspaceUploadTarget);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const acceptsPdf = /(?:application\/pdf|\.pdf)(?:,|$)/i.test(accept);
  const capture = async (file: File) => {
    setScanError(null);
    setScanning(true);
    try { onPick(acceptsPdf ? await scanImageToPdf(file) : file); }
    catch (error) { setScanError(error instanceof Error ? error.message : "Could not scan the document."); }
    finally { setScanning(false); }
  };
  const acceptsImages = accept.split(",").some((part) => /^(image\/|\.(png|jpe?g|heic|webp)$)/i.test(part.trim()));
  const content = <div data-attr={dataAttr} data-state="blank">
    <input ref={fileRef} type="file" accept={accept} className="sr-only" aria-label={label} disabled={disabled} data-attr={inputDataAttr ?? `${dataAttr}-input`} onChange={(event) => {
      const file = event.target.files?.[0];
      if (file && !disabled) {
        const refusal = fileRefusal(file, accept);
        setScanError(refusal);
        if (!refusal) onPick(file);
      }
      event.target.value = "";
    }} />
    {acceptsImages || acceptsPdf ? <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take photo" disabled={disabled} onChange={(event) => {
      const file = event.target.files?.[0];
      if (file && !disabled) { if (acceptsImages) onPick(file); else void capture(file); }
      event.target.value = "";
    }} /> : null}
    {acceptsImages || acceptsPdf ? <input ref={scanRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Scan document" disabled={disabled || scanning} onChange={(event) => {
      const file = event.target.files?.[0];
      if (file && !disabled) void capture(file);
      event.target.value = "";
    }} /> : null}
    {scanError ? <span role="alert" className="absolute right-4 top-16 z-10 max-w-xs rounded-xl border border-border bg-card p-3 text-sm text-destructive">{scanError}</span> : null}
    <DropdownMenu>
      <DropdownMenuTrigger asChild><PortalIconAction ring icon={Upload} label={scanning ? "Scanning…" : label} disabled={disabled || scanning} /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => fileRef.current?.click()}> <Upload className="size-4" aria-hidden /> Upload file</DropdownMenuItem>
        {acceptsImages || acceptsPdf ? <DropdownMenuItem onSelect={() => cameraRef.current?.click()}><Camera className="size-4" aria-hidden /> Take photo</DropdownMenuItem> : null}
        {acceptsImages || acceptsPdf ? <DropdownMenuItem onSelect={() => scanRef.current?.click()}><ScanLine className="size-4" aria-hidden /> Scan</DropdownMenuItem> : null}
        {extraItems?.map((item) => {
          const ItemIcon = item.icon;
          return <DropdownMenuItem key={item.label} data-attr={item.dataAttr} onSelect={item.onSelect}>{ItemIcon ? <ItemIcon className="size-4" aria-hidden /> : null} {item.label}</DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
  return target && !inline ? createPortal(content, target) : content;
}
