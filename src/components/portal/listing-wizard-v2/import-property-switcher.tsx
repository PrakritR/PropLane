"use client";

/**
 * "1 of 6 · 400 Pike St ▾" — moves between the properties one file produced.
 *
 * Sits in the listing workspace header between the title and the save state.
 * A liquid menu like every other menu; each row carries the property's
 * readiness pill so a manager can see which ones still need a look without
 * opening them.
 */

import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type ImportSwitcherEntry = {
  key: string;
  /** "400 Pike St" */
  label: string;
  /** "Seattle, WA · 4 rooms · by the room" */
  detail: string;
  /** Things the file left for the manager to check; empty means ready. */
  needsLook: string[];
};

/** "Ready", or how many things the file left to check — the pill stays short. */
export function importReadinessLabel(needsLook: string[]): string {
  if (needsLook.length === 0) return "Ready";
  return `${needsLook.length} to check`;
}

export function ImportPropertySwitcher({
  entries,
  selectedKey,
  onSelect,
  disabled = false,
}: {
  entries: ImportSwitcherEntry[];
  selectedKey: string;
  onSelect: (key: string) => void;
  /** While the previous property is still saving. */
  disabled?: boolean;
}) {
  const index = Math.max(0, entries.findIndex((e) => e.key === selectedKey));
  const current = entries[index];
  if (!current || entries.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        disabled={disabled}
        aria-label={`Imported property ${index + 1} of ${entries.length}: ${current.label}. Switch property`}
        data-attr="import-property-switcher"
        className="inline-flex min-h-[36px] max-w-[min(60vw,22rem)] items-center gap-2 rounded-full border border-border bg-card px-3 text-[13px] font-bold text-foreground transition hover:bg-accent/40 disabled:opacity-60"
      >
        <span className="shrink-0 rounded-full bg-primary/[0.08] px-2 py-0.5 text-[11px] font-bold text-[var(--pl-blue-deep)]">
          {index + 1} of {entries.length}
        </span>
        <span className="min-w-0 truncate">{current.label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[20rem] max-h-[min(var(--radix-dropdown-menu-content-available-height),26rem)] overflow-y-auto" data-attr="import-property-switcher-menu">
        {entries.map((entry) => {
          const ready = entry.needsLook.length === 0;
          return (
            <DropdownMenuItem
              key={entry.key}
              onSelect={() => onSelect(entry.key)}
              data-attr="import-property-switcher-item"
              aria-current={entry.key === selectedKey ? "true" : undefined}
              className={cn("items-start gap-3 py-2", entry.key === selectedKey && "bg-primary/[0.08]")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-bold">{entry.label}</span>
                <span className="block truncate text-[12px] font-medium text-muted">{entry.detail}</span>
              </span>
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold",
                  ready ? "bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]" : "bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
                )}
              >
                {importReadinessLabel(entry.needsLook)}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
