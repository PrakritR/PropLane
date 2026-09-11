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

/** Property-style card row — address block without trailing chevron. */
export function PortalPropertyRecordRow({
  title,
  address,
  summary,
  badge,
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
      {badge ? <div className="mt-0.5">{badge}</div> : null}
    </>
  );
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
    </div>
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
