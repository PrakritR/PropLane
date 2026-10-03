"use client";

import { createContext, useContext, useRef } from "react";
import { createPortal } from "react-dom";
import { Camera, Upload } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

/** File readers retain ownership of parsing and limits; only the picker moves to chrome. */
export const WorkspaceUploadTarget = createContext<HTMLElement | null>(null);

export function WorkspaceUploadAction({ accept, onPick, disabled, dataAttr, inputDataAttr, label = "Start from a file" }: {
  accept: string;
  onPick: (file: File) => void;
  disabled?: boolean;
  dataAttr: string;
  inputDataAttr?: string;
  label?: string;
}) {
  const target = useContext(WorkspaceUploadTarget);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const acceptsImages = accept.split(",").some((part) => /^(image\/|\.(png|jpe?g|heic|webp)$)/i.test(part.trim()));
  const content = <div data-attr={dataAttr} data-state="blank">
    <input ref={fileRef} type="file" accept={accept} className="sr-only" aria-label={label} disabled={disabled} data-attr={inputDataAttr ?? `${dataAttr}-input`} onChange={(event) => {
      const file = event.target.files?.[0];
      if (file && !disabled) onPick(file);
      event.target.value = "";
    }} />
    {acceptsImages ? <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take photo" disabled={disabled} onChange={(event) => {
      const file = event.target.files?.[0];
      if (file && !disabled) onPick(file);
      event.target.value = "";
    }} /> : null}
    <DropdownMenu>
      <DropdownMenuTrigger asChild><PortalIconAction ring icon={Upload} label={label} disabled={disabled} /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => fileRef.current?.click()}> <Upload className="size-4" aria-hidden /> Upload file</DropdownMenuItem>
        {acceptsImages ? <DropdownMenuItem onSelect={() => cameraRef.current?.click()}><Camera className="size-4" aria-hidden /> Take photo</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
  return target ? createPortal(content, target) : content;
}
