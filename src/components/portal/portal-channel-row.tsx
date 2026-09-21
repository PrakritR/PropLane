"use client";

import { MoreHorizontal, Plus, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Settings → Communication → Channels row shape (PLAN-0920-1530): channel ·
 * workspace · status · ⋯. Shared between the work-number rows and the work
 * email row in `pro-messaging-settings-panel.tsx` and
 * `pro-assistant-email-settings-panel.tsx` so the two channel kinds render
 * identically — one table, not two hand-matched layouts.
 */
export function ChannelRow({
  icon: Icon,
  channel,
  workspace,
  status,
  menu,
  dataAttr,
}: {
  icon: LucideIcon;
  channel: ReactNode;
  workspace: ReactNode;
  status: ReactNode;
  menu?: ReactNode;
  dataAttr?: string;
}) {
  return (
    <div
      data-attr={dataAttr}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-4 py-3 last:border-0 sm:flex-nowrap"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:basis-[38%]">
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">{channel}</span>
      </div>
      <div className="min-w-0 shrink-0 basis-full text-[12.5px] text-muted sm:basis-[26%] sm:truncate sm:pl-6">
        {workspace}
      </div>
      <div className="min-w-0 shrink-0 basis-full text-[12.5px] font-medium text-foreground sm:basis-[22%] sm:truncate">
        {status}
      </div>
      {menu ? <div className="ml-auto shrink-0">{menu}</div> : null}
    </div>
  );
}

/** The dashed "Add number" / "Add work email" row for a channel that does not exist yet. */
export function ChannelAddRow({
  label,
  meta,
  onClick,
  disabled,
  dataAttr,
}: {
  label: string;
  /** Trailing hint, e.g. "included · or $5/mo". Never a sentence — a short fact only. */
  meta?: string;
  onClick: () => void;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-attr={dataAttr}
      className="flex min-h-11 w-full items-center justify-between gap-3 border-b border-dashed border-border px-4 py-3 text-left text-[13px] font-medium text-muted transition-colors last:border-0 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex items-center gap-2">
        <Plus className="h-4 w-4 shrink-0" aria-hidden />
        {label}
      </span>
      {meta ? <span className="shrink-0 text-xs text-muted">{meta}</span> : null}
    </button>
  );
}

export type ChannelRowMenuItem = {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
};

/**
 * The per-row ⋯ menu. A native `<details>` popover — the same pattern
 * `allWorkspacesAction` already uses in this file — so it needs no portal
 * library and closes on its own when another one opens (only one `<details>`
 * can be the active focus target at a time in a keyboard flow, and a second
 * click anywhere outside collapses it via the browser's own light-dismiss).
 */
export function ChannelRowMenu({
  label,
  items,
  dataAttr,
}: {
  /** Accessible name for the trigger, e.g. "Work number (206) 555-0111 actions". */
  label: string;
  items: ChannelRowMenuItem[];
  dataAttr?: string;
}) {
  if (items.length === 0) return null;
  return (
    <details className="relative" data-attr={dataAttr}>
      <summary
        aria-label={label}
        title={label}
        className="grid size-9 shrink-0 cursor-pointer list-none place-items-center rounded-lg text-foreground/80 outline-none transition hover:bg-[var(--secondary)]/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/30 [&::-webkit-details-marker]:hidden"
      >
        <MoreHorizontal className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </summary>
      <div className="absolute right-0 z-20 mt-1.5 min-w-[13rem] rounded-2xl border border-border bg-card p-1 shadow-lg">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            data-attr={`${dataAttr ? `${dataAttr}-` : ""}${item.key}`}
            onClick={(event) => {
              // Close the popover before the action runs its own side effects
              // (e.g. opening a Modal on top of it).
              const details = event.currentTarget.closest("details");
              if (details) details.open = false;
              item.onClick();
            }}
            className={cn(
              "flex min-h-10 w-full items-center rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50",
              item.tone === "danger" ? "text-red-600" : "text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </details>
  );
}
