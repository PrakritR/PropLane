"use client";

import { createContext, useContext, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Camera, ScanLine, Upload } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { scanImageToPdf } from "./scan-document";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

/** File readers retain ownership of parsing and limits; only the picker moves to chrome. */
export const WorkspaceUploadTarget = createContext<HTMLElement | null>(null);

/**
 * True when the pop-up draws ONE Upload icon at its top level (`AddWorkspace`'s `headerUpload`).
 * A step strip then stays out of the header: it keeps its reading / replace-confirm / filled
 * states, but draws no second Upload icon of its own in the blank state.
 */
export const WorkspaceHeaderUploadPresent = createContext(false);

/** One more door in the Upload icon's menu — another way to bring a file in (e.g. a whole-portfolio import). */
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
  label?: string;
  extraItems?: WorkspaceUploadExtraItem[];
};

/** The pop-up's single header Upload icon: Upload file · Take photo · Scan, on every step. */
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
      if (file && !disabled) onPick(file);
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
