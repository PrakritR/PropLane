"use client";

/**
 * The public top bar's search overlay — a lightweight command palette over
 * REAL site routes only (no invented destinations). Built directly on
 * `@radix-ui/react-dialog` rather than the heavier portal `modal.tsx` system
 * (that one carries portal-container/assistant-strip coupling this marketing
 * surface doesn't need); Esc-to-close and focus trapping come from Radix for
 * free.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type PublicSearchItem = { title: string; url: string; group: string };

export function PublicSearchOverlay({
  items,
  open,
  onOpenChange,
}: {
  items: PublicSearchItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => `${item.title} ${item.group}`.toLowerCase().includes(q));
  }, [items, query]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in" />
        <Dialog.Content
          className="fixed left-1/2 top-[14vh] z-[71] w-[92vw] max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-card text-left shadow-[0_32px_80px_-24px_rgba(11,27,58,0.45)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Search PropLane</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <Search className="size-4 shrink-0 text-muted" strokeWidth={2} aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pages…"
              data-attr="public-search-input"
              className="min-w-0 flex-1 bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-muted"
            />
            <Dialog.Close
              aria-label="Close search"
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <ul className="max-h-[50vh] overflow-y-auto py-1.5" data-attr="public-search-results">
            {results.length === 0 ? (
              <li className="px-4 py-6 text-center text-[13px] text-muted">No pages match &ldquo;{query}&rdquo;.</li>
            ) : (
              // Several distinct entries share a real url on purpose (e.g.
              // Leasing/Payments/Services all point at the same in-page
              // anchor) — key by title+url, not url alone, or React drops
              // the "duplicate" siblings.
              results.map((item, i) => (
                <li key={`${item.title}-${item.url}`}>
                  <Dialog.Close asChild>
                    <Link
                      href={item.url}
                      data-attr="public-search-result"
                      className={cn(
                        "flex items-center justify-between gap-3 px-4 py-2.5 text-[13.5px] text-foreground transition-colors hover:bg-accent",
                        i === 0 && query ? "bg-accent" : "",
                      )}
                    >
                      <span className="font-medium">{item.title}</span>
                      <span className="shrink-0 text-[11.5px] text-muted">{item.group}</span>
                    </Link>
                  </Dialog.Close>
                </li>
              ))
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
