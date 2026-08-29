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
  onOpen: () => void;
  dataAttr?: string;
  trailing?: ReactNode;
}) {
  return (
    <div data-attr={dataAttr}>
      <InboxConversationRow
        name={name}
        subtitle={subtitle}
        preview={preview ?? subtitle ?? ""}
        time={meta ?? ""}
        selected={selected}
        onOpen={onOpen}
        trailing={trailing}
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
  onOpen: () => void;
  dataAttr?: string;
}) {
  const selectable = Boolean(onSelectedChange);
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
    </div>
  );
}

/** Generic service / work-order row with optional status chip. */
export function PortalServiceRecordRow({
  title,
  subtitle,
  statusLabel,
  statusTone = "neutral",
  selected = false,
  onOpen,
  dataAttr,
}: {
  title: string;
  subtitle?: string;
  statusLabel?: string;
  statusTone?: "neutral" | "warning" | "success" | "danger";
  selected?: boolean;
  onOpen: () => void;
  dataAttr?: string;
}) {
  const toneClass =
    statusTone === "warning"
      ? "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]"
      : statusTone === "success"
        ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]"
        : statusTone === "danger"
          ? "bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]"
          : "bg-accent/60 text-muted";

  return (
    <button
      type="button"
      data-attr={dataAttr}
      onClick={onOpen}
      className={`portal-service-row flex w-full items-center gap-3 border-b border-border/50 px-3 py-3 text-left transition-colors max-md:px-2.5 max-md:py-2.5 ${
        selected
          ? "border-l-[3px] border-l-primary bg-primary/[0.06]"
          : "border-l-[3px] border-l-transparent hover:bg-foreground/[0.03]"
      }`}
    >
      <InboxAvatar name={title} className="h-9 w-9 shrink-0 text-[11px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium text-foreground">{title}</p>
          {statusLabel ? (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${toneClass}`}>
              {statusLabel}
            </span>
          ) : null}
        </div>
        {subtitle ? <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p> : null}
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted" aria-hidden />
    </button>
  );
}
