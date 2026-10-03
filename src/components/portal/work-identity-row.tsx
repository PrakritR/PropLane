"use client";
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Modal } from "@/components/ui/modal";

/** The compact identity value opens the existing real setup and management controls. */
export function WorkIdentityRow({ label, value, children, onOpen, dataAttr }: {
  label: string; value: ReactNode; children?: ReactNode; onOpen?: () => void; dataAttr?: string;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-label={`${label} ${typeof value === "string" ? value : ""}`.trim()} className="flex min-h-12 w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left text-[15px] last:border-0" onClick={onOpen ?? (() => setOpen(true))} data-attr={dataAttr}>
      <span className="shrink-0">{label}</span><span className="ml-auto min-w-0 truncate text-right text-muted">{value}</span><ChevronRight className="size-4 shrink-0 text-muted" />
    </button>
    {children ? <Modal open={open} onClose={() => setOpen(false)} title={label}>{children}</Modal> : null}
  </>;
}
