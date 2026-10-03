"use client";

import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Inline (i) beside a section label — opens a short popover, never navigates.
 * Muted until hover/focus/active; always visible on touch (`hover:none`).
 */
export function PortalPropertySectionInfo({
  title,
  body,
  className,
  dataAttr,
}: {
  title: string;
  body: string;
  className?: string;
  dataAttr?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <span ref={rootRef} className={cn("relative inline-flex align-middle", className)}>
      <button
        type="button"
        aria-label={`About ${title}`}
        aria-expanded={open}
        aria-controls={popoverId}
        data-attr={dataAttr ?? "property-section-info"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-muted opacity-0 transition hover:text-primary hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-80 group-focus-within:opacity-80 [@media(hover:none)]:opacity-70"
      >
        <Info className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      </button>
      {open ? (
        <div
          id={popoverId}
          role="dialog"
          className="absolute left-0 top-[calc(100%+8px)] z-[80] w-[236px] rounded-2xl border border-border bg-card p-3.5 text-left text-[13.5px] leading-snug text-foreground shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <b className="mb-1 block text-[13.5px] font-bold">{title}</b>
          <p>{body}</p>
        </div>
      ) : null}
    </span>
  );
}
