"use client";

import { MoreHorizontal, Plus, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  RECORD_ACTION_TRIGGER_BUTTON_CLASS,
  RECORD_ACTION_TRIGGER_ICON_CLASS,
} from "@/components/ui/record-action-menu";
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
  /** When true, the channel cell wraps instead of truncating — rename inputs must stay fully visible. */
  channelWrap = false,
}: {
  icon: LucideIcon;
  channel: ReactNode;
  workspace: ReactNode;
  status: ReactNode;
  menu?: ReactNode;
  dataAttr?: string;
  channelWrap?: boolean;
}) {
  return (
    <div
      data-attr={dataAttr}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-4 py-3 last:border-0 sm:flex-nowrap"
    >
      <div className={cn("flex min-w-0 flex-1 items-center gap-2", channelWrap ? "basis-full sm:basis-[55%]" : "sm:basis-[38%]")}>
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span
          className={cn(
            "min-w-0 text-[13.5px] font-semibold text-foreground",
            channelWrap ? "flex flex-wrap items-center gap-1.5" : "truncate",
          )}
        >
          {channel}
        </span>
      </div>
      <div className="min-w-0 shrink-0 basis-full text-[12.5px] text-muted sm:basis-[26%] sm:truncate sm:pl-6">
        {workspace}
      </div>
      <div className="min-w-0 shrink-0 basis-full text-[12.5px] font-medium text-foreground sm:basis-[22%] sm:truncate">
        {status}
      </div>
      {menu ? <div className="relative z-10 ml-auto shrink-0">{menu}</div> : null}
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
 * Per-row ⋯ menu. Portaled via DropdownMenu so `PortalSettingsGroup`'s
 * `overflow-hidden` cannot clip it under the next section (Automation).
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
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-label={label}
          title={label}
          className={RECORD_ACTION_TRIGGER_BUTTON_CLASS}
          data-attr={dataAttr ? `${dataAttr}-trigger` : "channel-row-menu-trigger"}
        >
          <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="z-[10060] min-w-[13rem]"
        data-attr={dataAttr ?? "channel-row-menu"}
        aria-label={label}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            disabled={item.disabled}
            data-attr={`${dataAttr ? `${dataAttr}-` : ""}${item.key}`}
            className={cn(item.tone === "danger" && "text-red-600 focus:text-red-600")}
            onSelect={(event) => {
              event.preventDefault();
              item.onClick();
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
