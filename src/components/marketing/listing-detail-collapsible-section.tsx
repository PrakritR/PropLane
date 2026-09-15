"use client";

import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

export const listingSectionScrollClass =
  "scroll-mt-[var(--listing-sticky-stack,calc(env(safe-area-inset-top,0px)+9.5rem))]";

/** Kept for callers that still wrap something in the old card chrome. */
export const listingSectionCardClass =
  "rounded-2xl border border-border bg-card shadow-sm backdrop-blur-sm";

/**
 * One section of the listing page (PLAN-0914-2124): a flat block under a hairline,
 * never a card inside a card. On a phone, when `collapseOnMobile` is on, the
 * whole heading row is the toggle and a chevron says which way it goes; from
 * `md` up every section is simply open.
 */
function SectionHeading({
  id,
  title,
  eyebrow,
  headerAside,
  collapsible,
  open,
  onToggle,
  dataAttrToggle,
}: {
  id?: string;
  title: string;
  eyebrow?: string;
  headerAside?: ReactNode;
  collapsible: boolean;
  open: boolean;
  onToggle: () => void;
  dataAttrToggle?: string;
}) {
  const heading = (
    <div className="min-w-0 flex-1">
      {eyebrow ? <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">{eyebrow}</p> : null}
      <h2 className="text-lg font-bold tracking-tight text-foreground sm:text-xl" id={id ? `${id}-heading` : undefined}>
        {title}
      </h2>
    </div>
  );
  if (!collapsible) {
    return (
      <div className="flex items-center justify-between gap-3">
        {heading}
        {headerAside ? <div className="shrink-0">{headerAside}</div> : null}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={onToggle}
        data-attr={dataAttrToggle}
        aria-expanded={open}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 text-left md:pointer-events-none"
      >
        {heading}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted transition-transform duration-200 md:hidden ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {headerAside ? <div className="shrink-0">{headerAside}</div> : null}
    </div>
  );
}

export function ListingDetailCollapsibleSection({
  id,
  title,
  eyebrow,
  headerAside,
  children,
  collapseOnMobile = true,
  defaultOpen = false,
  dataAttrToggle,
  className = "",
  contentClassName = "",
}: {
  id?: string;
  title: string;
  eyebrow?: string;
  headerAside?: ReactNode;
  children: ReactNode;
  /** When true (default), content is collapsed on small screens; md+ always expanded. */
  collapseOnMobile?: boolean;
  /** Start open on a phone (the first section a renter wants). */
  defaultOpen?: boolean;
  dataAttrToggle?: string;
  className?: string;
  contentClassName?: string;
  /** Accepted for old callers; every section is the same shape now. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const mobileContentClass = collapseOnMobile ? (open ? "block" : "hidden md:block") : "block";

  return (
    <section
      id={id}
      className={`${listingSectionScrollClass} border-t border-border pt-6 first:border-t-0 first:pt-0 ${className}`}
      aria-labelledby={id ? `${id}-heading` : undefined}
    >
      <SectionHeading
        id={id}
        title={title}
        eyebrow={eyebrow}
        headerAside={headerAside}
        collapsible={collapseOnMobile}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        dataAttrToggle={dataAttrToggle}
      />
      <div className={`mt-4 ${mobileContentClass} ${contentClassName}`}>{children}</div>
    </section>
  );
}

/** Same section, for prose: when there is nothing to show it says so in one line. */
export function ListingDetailCollapsibleSimpleSection({
  id,
  title,
  children,
  emptyMessage,
  hasContent = true,
  dataAttrToggle,
  className = "",
  collapseOnMobile = true,
  defaultOpen = false,
}: {
  id?: string;
  title: string;
  children: ReactNode;
  emptyMessage?: string;
  hasContent?: boolean;
  dataAttrToggle?: string;
  className?: string;
  collapseOnMobile?: boolean;
  defaultOpen?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const mobileContentClass = collapseOnMobile ? (open ? "block" : "hidden md:block") : "block";

  return (
    <section
      id={id}
      className={`${listingSectionScrollClass} border-t border-border pt-6 first:border-t-0 first:pt-0 ${className}`}
      aria-labelledby={id ? `${id}-heading` : undefined}
    >
      <SectionHeading
        id={id}
        title={title}
        collapsible={hasContent && collapseOnMobile}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        dataAttrToggle={dataAttrToggle}
      />
      {!hasContent && emptyMessage ? (
        <p className="mt-3 text-sm text-muted">{emptyMessage}</p>
      ) : hasContent ? (
        <div className={`mt-4 ${mobileContentClass}`}>{children}</div>
      ) : null}
    </section>
  );
}
