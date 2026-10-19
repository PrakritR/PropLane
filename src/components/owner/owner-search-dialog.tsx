"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ownerNavItems, ownerMoneyTabs } from "@/lib/property-owner/sections";
import { cn } from "@/lib/utils";

export type OwnerSearchTarget = { id: string; label: string; href: string; group: string };

/** Where "search" can jump: the five rows and the Money tabs. Case-insensitive substring on label and group. */
export function ownerSearchTargets(messagesOn: boolean, financesOn: boolean): OwnerSearchTarget[] {
  const rows: OwnerSearchTarget[] = ownerNavItems(messagesOn).map((item) => ({ id: item.id, label: item.label, href: item.href, group: "Go to" }));
  const tabs: OwnerSearchTarget[] = ownerMoneyTabs(financesOn).map((tab) => ({ id: `money-${tab.id}`, label: tab.label, href: tab.href, group: "Money" }));
  return [...rows, ...tabs];
}

export function filterOwnerSearch(targets: readonly OwnerSearchTarget[], query: string): OwnerSearchTarget[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...targets];
  return targets.filter((t) => `${t.label} ${t.group}`.toLowerCase().includes(q));
}

/** The top strip's search: jump to a page or a house. Cmd/Ctrl+K opens it; Escape closes; Enter runs the highlighted row. */
export function OwnerSearchDialog({
  open,
  onOpenChange,
  targets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: readonly OwnerSearchTarget[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
    }
  }, [open]);
  const rows = useMemo(() => filterOwnerSearch(targets, query), [targets, query]);
  useEffect(() => setSelected((i) => Math.min(i, Math.max(rows.length - 1, 0))), [rows.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected, rows]);
  const run = (row: OwnerSearchTarget | undefined) => {
    if (!row) return;
    onOpenChange(false);
    router.push(row.href);
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[14vh] z-[81] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-xl outline-none"
          data-attr="owner-search"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSelected((i) => (rows.length ? (i + 1) % rows.length : 0));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelected((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  run(rows[selected]);
                }
              }}
              placeholder="Search pages"
              aria-label="Search"
              className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted"
            />
          </div>
          <div ref={listRef} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
            {rows.length === 0 ? <p className="px-3 py-6 text-center text-sm text-muted">No matches</p> : null}
            {rows.map((row, index) => (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={index === selected}
                data-selected={index === selected}
                onMouseEnter={() => setSelected(index)}
                onClick={() => run(row)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-foreground",
                  index === selected && "bg-accent",
                )}
              >
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 text-xs text-muted">{row.group}</span>
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
