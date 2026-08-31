"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { InboxAvatar, InboxConversationRow } from "@/components/portal/portal-inbox-ui";

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
}) {
  // Opt-in, mirroring PortalPropertyRecordRow: a list that does not pass a
  // handler keeps exactly the layout it had before.
  const selectable = Boolean(onSelectedChange);
  return (
    <div data-attr={dataAttr}>
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
            <input
              type="checkbox"
              className="ml-3 mr-1 mt-1 h-4 w-4 shrink-0 self-start rounded border-border"
              checked={checked}
              onChange={(e) => onSelectedChange?.(e.target.checked)}
              onClick={(e) => e.stopPropagation()}
              data-portal-row-ignore
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
  return (
    <div
      className={`portal-property-row flex w-full items-stretch border-b border-border/50 px-3 py-3 transition-colors max-md:px-2.5 max-md:py-2.5 ${
        selected || checked
          ? "border-l-[3px] border-l-primary bg-primary/[0.06]"
          : "border-l-[3px] border-l-transparent hover:bg-foreground/[0.03]"
      }`}
    >
      {selectable ? (
        <input
          type="checkbox"
          className="mr-3 mt-1 h-4 w-4 shrink-0 rounded border-border"
          checked={checked}
          onChange={(e) => onSelectedChange?.(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          data-portal-row-ignore
          aria-label={`Select ${title}`}
        />
      ) : null}
      {openable ? (
        <button
          type="button"
          data-attr={dataAttr}
          onClick={onOpen}
          className="flex min-w-0 flex-1 flex-col gap-1 text-left"
        >
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          <p className="text-xs leading-relaxed text-muted">{address}</p>
          {summary ? <p className="text-xs text-muted">{summary}</p> : null}
          {badge ? <div className="mt-0.5">{badge}</div> : null}
        </button>
      ) : (
        <div data-attr={dataAttr} className="flex min-w-0 flex-1 flex-col gap-1 text-left">
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          <p className="text-xs leading-relaxed text-muted">{address}</p>
          {summary ? <p className="text-xs text-muted">{summary}</p> : null}
          {badge ? <div className="mt-0.5">{badge}</div> : null}
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
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 rounded border-border accent-primary"
          checked={checked}
          onChange={(e) => onSelectedChange?.(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          data-portal-row-ignore
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
