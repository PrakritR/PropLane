"use client";

/**
 * The portal command palette (approved shell redesign, opened from the top
 * strip's "Ask PropLane or search ..." bar or with Cmd/Ctrl+K).
 *
 * Three groups, in this order:
 *   ASK      the first option is always "Ask PropLane: <query>" and opens the
 *            portal's own assistant (the caller wires it to the same launcher
 *            the strip uses, so a resident gets the resident assistant, a
 *            vendor the vendor one, a manager the manager one);
 *   JUMP TO  the portal's sidebar sections, filtered by the query;
 *   ACTIONS  existing create entry points that are reachable by URL today
 *            (manager only: New message, New workspace).
 *
 * Built on `@radix-ui/react-dialog` like the public search overlay: Escape,
 * focus trap and focus return come from Radix. Keyboard: Up/Down move, Enter
 * runs the highlighted row, Escape closes. No new dependency.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { Plus, Sparkles, MessageSquarePlus, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import type { PortalJumpItem } from "@/components/portal/use-portal-jump-items";
import { cn } from "@/lib/utils";

export type PortalPaletteAction = {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
};

/** Create entry points a manager can reach by URL today. Other portals have none. */
export function portalPaletteActions(basePath: string, kind: string): PortalPaletteAction[] {
  if (kind !== "manager" && kind !== "pro") return [];
  return [
    { id: "new-message", label: "New message", href: `${basePath}/communication/active?compose=1`, icon: MessageSquarePlus },
    { id: "new-workspace", label: "New workspace", href: `${basePath}/profile?tab=workspaces&new=1`, icon: Plus },
  ];
}

/** Case-insensitive substring match on the section label or its sidebar heading. */
export function filterPaletteJumpItems(items: PortalJumpItem[], query: string): PortalJumpItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => `${item.label} ${item.group ?? ""}`.toLowerCase().includes(q));
}

export function filterPaletteActions(actions: PortalPaletteAction[], query: string): PortalPaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return actions;
  return actions.filter((action) => action.label.toLowerCase().includes(q));
}

type Row =
  | { kind: "ask"; key: string; label: string }
  | { kind: "jump"; key: string; item: PortalJumpItem }
  | { kind: "action"; key: string; action: PortalPaletteAction };

export function PortalCommandPalette({
  open,
  onOpenChange,
  jumpItems,
  actions,
  onAsk,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jumpItems: PortalJumpItem[];
  actions: PortalPaletteAction[];
  /** Opens the portal's own assistant; `query` is what the user typed ("" when nothing). */
  onAsk: (query: string) => void;
  onNavigate: (href: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);

  const jump = useMemo(() => filterPaletteJumpItems(jumpItems, query), [jumpItems, query]);
  const acts = useMemo(() => filterPaletteActions(actions, query), [actions, query]);

  const rows = useMemo<Row[]>(() => {
    const trimmed = query.trim();
    return [
      { kind: "ask", key: "ask", label: trimmed ? `Ask PropLane: ${trimmed}` : "Ask PropLane" },
      ...jump.map((item): Row => ({ kind: "jump", key: `jump-${item.section}`, item })),
      ...acts.map((action): Row => ({ kind: "action", key: `action-${action.id}`, action })),
    ];
  }, [acts, jump, query]);

  // A keystroke can narrow the list under the highlight; clamp it back onto a real row.
  useEffect(() => {
    setSelected((i) => Math.min(i, rows.length - 1));
  }, [rows.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected, rows]);

  /**
   * Set by an Ask row so the dialog's close does NOT pull focus back to
   * whatever had it before the palette opened: `onAsk` has just put the caret
   * in the assistant composer, and Radix's own close-autofocus would take it
   * straight back out again.
   */
  const askedRef = useRef(false);

  function run(row: Row | undefined) {
    if (!row) return;
    if (row.kind === "ask") askedRef.current = true;
    onOpenChange(false);
    if (row.kind === "ask") onAsk(query.trim());
    else if (row.kind === "jump") onNavigate(row.item.href);
    else onNavigate(row.action.href);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(rows[selected]);
    }
  }

  const groupLabel = "px-4 pb-1 pt-2.5 text-[11.5px] font-[650] uppercase tracking-[0.02em] text-[#9ba1ac]";

  const renderRow = (row: Row, index: number) => {
    const isSelected = index === selected;
    const common = {
      id: `portal-palette-row-${index}`,
      role: "option" as const,
      "aria-selected": isSelected,
      "data-selected": isSelected ? "true" : undefined,
      "data-attr": `portal-palette-${row.kind}`,
      onMouseMove: () => setSelected(index),
      onClick: () => run(row),
      className: cn(
        "flex cursor-pointer items-center gap-2.5 px-4 py-2 text-[14px] text-foreground",
        isSelected && "bg-[#f1f5ff]",
      ),
    };
    if (row.kind === "ask") {
      return (
        <div key={row.key} {...common}>
          <Sparkles className="size-4 shrink-0 text-[#2863f0]" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <span className="shrink-0 text-[12px] text-[#9ba1ac]" aria-hidden>
            ↵
          </span>
        </div>
      );
    }
    if (row.kind === "jump") {
      return (
        <div key={row.key} {...common}>
          <PortalNavIcon section={row.item.section} className="size-4 shrink-0 text-[#3c414b]" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">{row.item.label}</span>
        </div>
      );
    }
    const Icon = row.action.icon;
    return (
      <div key={row.key} {...common}>
        <Icon className="size-4 shrink-0 text-[#3c414b]" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{row.action.label}</span>
      </div>
    );
  };

  const jumpStart = 1;
  const actionStart = 1 + jump.length;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10080] bg-[rgba(16,24,40,0.35)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          data-surface="light"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            if (!askedRef.current) return;
            askedRef.current = false;
            e.preventDefault();
          }}
          className="fixed left-1/2 top-[72px] z-[10081] w-[600px] max-w-[calc(100%-40px)] -translate-x-1/2 overflow-hidden rounded-xl border border-[rgba(17,24,39,0.13)] bg-white text-[#15171c] shadow-[0_24px_60px_-12px_rgba(16,24,40,0.4)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
          data-attr="portal-command-palette"
        >
          <Dialog.Title className="sr-only">Ask PropLane or search</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-[rgba(17,24,39,0.085)] px-4 py-3.5">
            <Sparkles className="size-4 shrink-0 text-[#2863f0]" strokeWidth={1.75} aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Ask PropLane or search..."
              role="combobox"
              aria-expanded
              aria-controls="portal-palette-list"
              aria-activedescendant={`portal-palette-row-${selected}`}
              aria-label="Ask PropLane or search"
              data-attr="portal-palette-input"
              className="min-w-0 flex-1 border-0 bg-transparent text-[16px] text-[#15171c] outline-none placeholder:text-[#9ba1ac]"
            />
          </div>

          <div ref={listRef} id="portal-palette-list" role="listbox" className="max-h-[min(60vh,440px)] overflow-y-auto pb-1.5">
            <p className={groupLabel}>Ask</p>
            {renderRow(rows[0]!, 0)}

            {jump.length ? (
              <>
                <p className={groupLabel}>Jump to</p>
                {jump.map((item, i) => renderRow(rows[jumpStart + i]!, jumpStart + i))}
              </>
            ) : null}

            {acts.length ? (
              <>
                <p className={groupLabel}>Actions</p>
                {acts.map((action, i) => renderRow(rows[actionStart + i]!, actionStart + i))}
              </>
            ) : null}
          </div>

          <div className="flex gap-3.5 border-t border-[rgba(17,24,39,0.085)] px-4 py-2 text-[12px] text-[#9ba1ac]">
            <span>
              <kbd className="mr-1 rounded-[4px] border border-[rgba(17,24,39,0.13)] px-1 font-semibold text-[#6a707c]">↑↓</kbd>
              move
            </span>
            <span>
              <kbd className="mr-1 rounded-[4px] border border-[rgba(17,24,39,0.13)] px-1 font-semibold text-[#6a707c]">↵</kbd>
              open
            </span>
            <span>
              <kbd className="mr-1 rounded-[4px] border border-[rgba(17,24,39,0.13)] px-1 font-semibold text-[#6a707c]">esc</kbd>
              close
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
