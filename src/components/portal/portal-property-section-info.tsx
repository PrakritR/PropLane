"use client";

import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    // Rendered in a body portal at a fixed spot so a rail card's overflow never clips it.
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 236;
      setPos({ top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
    };
    place();
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={cn("relative inline-flex align-middle", className)}>
      {/* Not a <button>: it sits inside the rail item's own button, and a nested
          button is invalid HTML (hydration error). Same role, focus and keys. */}
      <span
        role="button"
        tabIndex={0}
        aria-label={`About ${title}`}
        aria-expanded={open}
        aria-controls={popoverId}
        data-attr={dataAttr ?? "property-section-info"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="relative inline-flex h-[18px] w-[18px] items-center max-md:before:absolute max-md:before:-inset-[13px] max-md:before:content-[''] justify-center rounded-full text-muted opacity-0 transition hover:text-primary hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-80 group-focus-within:opacity-80 [@media(hover:none)]:opacity-70"
      >
        <Info className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      </span>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popRef}
              id={popoverId}
              role="dialog"
              style={{ top: pos.top, left: pos.left }}
              className="fixed z-[120] w-[236px] rounded-2xl border border-border bg-card p-3.5 text-left text-[13.5px] leading-snug text-foreground shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <b className="mb-1 block text-[13.5px] font-bold">{title}</b>
              <p>{body}</p>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
