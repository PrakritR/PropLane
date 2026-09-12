"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { InboxAvatar, InboxConversationRow } from "@/components/portal/portal-inbox-ui";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";

/** Person-centric list row (residents, applications, vendors). */
export function PortalPersonRecordRow({
  name,
  subtitle,
  preview,
  meta,
  badge,
  selected = false,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
  trailing,
  rowId,
}: {
  name: string;
  subtitle?: string;
  preview?: string;
  meta?: string;
  badge?: ReactNode;
  selected?: boolean;
  /** Multi-select state. Pass `onSelectedChange` to show the checkbox at all. */
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
  trailing?: ReactNode;
  /** Stable id for tests and deep links (e.g. `resident-application-AXIS-…`). */
  rowId?: string;
}) {
  // Opt-in, mirroring PortalPropertyRecordRow: a list that does not pass a
  // handler keeps exactly the layout it had before.
  const selectable = Boolean(onSelectedChange);
  return (
    <div data-attr={dataAttr} id={rowId}>
      <InboxConversationRow
        name={name}
        subtitle={subtitle}
        preview={preview ?? subtitle ?? ""}
        time={meta ?? ""}
        selected={selected || checked}
        onOpen={onOpen}
        trailing={trailing}
        leading={
          selectable ? (
            // Was `ml-3 mr-1 mt-1` on the bare box; each side minus the 12 px pad.
            <RowSelectCheckbox
              wrapperClassName="ml-0 -mr-2 -mt-2 self-start"
              checked={checked}
              onChange={(e) => onSelectedChange?.(e.target.checked)}
              aria-label={`Select ${name}`}
            />
          ) : undefined
        }
      />
      {badge ? <div className="px-3 pb-2 -mt-1 max-md:px-2.5">{badge}</div> : null}
    </div>
  );
}

/**
 * Property-style card row.
 *
 * Title with a chevron, the address, a line of detail; on the right, a status
 * chip ("1 / 2 occupied") and the money in bold — the two things a manager
 * scans a list of homes for. On a phone the chip drops under the title and
 * the money stays on the right, so the row is still two lines and a glance.
 */
export function PortalPropertyRecordRow({
  title,
  address,
  summary,
  badge,
  chip,
  trailing,
  leading,
  selected = false,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
}: {
  title: string;
  address: string;
  summary?: string;
  badge?: ReactNode;
  /** Status chip — occupancy, stage — shown beside the money. */
  chip?: ReactNode;
  /** The money, right-aligned and bold. */
  trailing?: ReactNode;
  /** A thumbnail or glyph before the text — what makes one row recognisable among twenty. */
  leading?: ReactNode;
  selected?: boolean;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /**
   * Omit for a row with nothing to open. A read-only list (finance entries)
   * still wants this row's typography, and rendering a button that does
   * nothing would announce itself to a screen reader as actionable.
   */
  onOpen?: () => void;
  dataAttr?: string;
}) {
  const selectable = Boolean(onSelectedChange);
  const openable = Boolean(onOpen);
  const body = (
    <>
      <p className="flex min-w-0 items-center gap-1 text-[15px] font-semibold leading-tight text-foreground">
        <span className="truncate">{title}</span>
        {openable ? <ChevronRight className="size-4 shrink-0 text-muted/70" strokeWidth={2} aria-hidden /> : null}
      </p>
      <p className="truncate text-[13px] leading-relaxed text-muted">{address}</p>
      {summary ? <p className="truncate text-xs text-muted">{summary}</p> : null}
      {badge || chip || trailing ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {badge}
          {/* On a phone the chip and the money sit under the title, so the title
              keeps its width; on desktop both move to the right edge. */}
          {chip ? <span className="md:hidden">{chip}</span> : null}
          {trailing ? <span className="text-[13px] font-bold text-foreground md:hidden">{trailing}</span> : null}
        </div>
      ) : null}
    </>
  );
  const aside =
    chip || trailing ? (
      <div className="ml-2 hidden shrink-0 flex-col items-end justify-center gap-1 self-center text-right md:flex">
        {trailing ? <span className="whitespace-nowrap text-[14px] font-bold text-foreground">{trailing}</span> : null}
        {chip}
      </div>
    ) : null;
  return (
    <div
      className={cn(
        // One white card per property — no group heading, no repeated status
        // badge — with the row title opening the record and a separate 44px
        // selection target.
        "portal-property-row mb-2 flex w-full items-center gap-1 rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-colors max-md:px-2.5",
        selected || checked ? "border-primary/40 bg-primary/[0.04]" : "border-border hover:border-primary/30",
      )}
    >
      {selectable ? (
        <RowSelectCheckbox
          wrapperClassName="mr-0 self-center"
          checked={checked}
          onChange={(e) => onSelectedChange?.(e.target.checked)}
          aria-label={`Select ${title}`}
        />
      ) : null}
      {leading ? <div className="mr-3 shrink-0 self-start">{leading}</div> : null}
      {openable ? (
        <button
          type="button"
          data-attr={dataAttr}
          onClick={onOpen}
          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 text-left"
        >
          {body}
        </button>
      ) : (
        <div data-attr={dataAttr} className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 text-left">
          {body}
        </div>
      )}
      {aside}
    </div>
  );
}

/** A small status chip for a list row — "1 / 2 occupied", "Vacant". */
export function PortalRowStatusChip({
  tone = "neutral",
  children,
  dataAttr,
}: {
  tone?: "ok" | "warn" | "neutral";
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <span
      data-attr={dataAttr}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
        tone === "ok"
          ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
          : tone === "warn"
            ? "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]"
            : "bg-[var(--secondary)] text-muted",
      )}
    >
      {children}
    </span>
  );
}

/** Generic service / work-order list row. */
export function PortalServiceRecordRow({
  title,
  subtitle,
  selected = false,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
}: {
  title: string;
  subtitle?: string;
  selected?: boolean;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
}) {
  const selectable = Boolean(onSelectedChange);
  const highlighted = selected || checked;

  return (
    <div
      className={`portal-service-row flex w-full items-center gap-3 border-b border-border/50 px-3 py-3 transition-colors max-md:px-2.5 max-md:py-2.5 ${
        highlighted
          ? "border-l-[3px] border-l-primary bg-primary/[0.06]"
          : "border-l-[3px] border-l-transparent hover:bg-foreground/[0.03]"
      }`}
    >
      {selectable ? (
        <RowSelectCheckbox
          checked={checked}
          onChange={(e) => onSelectedChange?.(e.target.checked)}
          aria-label={`Select ${title}`}
        />
      ) : null}
      <button
        type="button"
        data-attr={dataAttr}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <InboxAvatar name={title} className="h-9 w-9 shrink-0 text-[11px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {subtitle ? <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p> : null}
        </div>
      </button>
    </div>
  );
}
