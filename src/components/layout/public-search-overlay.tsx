"use client";

/**
 * The public top bar's search overlay — a full-width "ask anything" bar over
 * REAL site routes only (no invented destinations), styled after openai.com's
 * search (captain 2026-09-25, item 7). Built directly on
 * `@radix-ui/react-dialog` rather than the heavier portal `modal.tsx` system
 * (that one carries portal-container/assistant-strip coupling this marketing
 * surface doesn't need); Esc-to-close and focus trapping come from Radix for
 * free.
 *
 * `data-surface="light"` (see `globals.css`'s "Always-light embeds" block)
 * rebinds `--background`/`--card`/`--border`/`--foreground` to the light
 * palette regardless of the surrounding theme, so this panel is always white
 * even if `--card` were ever dark somewhere else in the app.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => `${item.title} ${item.group}`.toLowerCase().includes(q));
  }, [items, query]);

  // The highlighted row can go stale (a keystroke narrows the list) — clamp
  // it back onto a real result instead of pointing past the end.
  useEffect(() => {
    setSelectedIndex((i) => (results.length === 0 ? 0 : Math.min(i, results.length - 1)));
  }, [results]);

  function openResult(item: PublicSearchItem | undefined) {
    if (!item) return;
    router.push(item.url);
    onOpenChange(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      openResult(results[selectedIndex]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/30 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in" />
        <Dialog.Content
          data-surface="light"
          className="fixed inset-x-0 top-14 z-[71] w-full border-b border-border bg-card text-left shadow-[0_24px_48px_-24px_rgba(11,27,58,0.35)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:fade-in data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Search PropLane</Dialog.Title>
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
            <div className="flex items-center gap-3 border-b border-border pb-4">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about PropLane"
                data-attr="public-search-input"
                className="min-w-0 flex-1 bg-transparent text-[28px] font-medium leading-tight text-foreground outline-none placeholder:text-muted sm:text-[40px]"
              />
              <button
                type="button"
                aria-label="Search"
                data-attr="public-search-submit"
                onClick={() => openResult(results[selectedIndex])}
                className="grid size-11 shrink-0 place-items-center rounded-full bg-foreground text-background transition hover:opacity-90"
              >
                <ArrowRight className="size-5" strokeWidth={2.25} aria-hidden />
              </button>
            </div>
            <ul className="mt-3 flex max-h-[50vh] flex-col overflow-y-auto" data-attr="public-search-results">
              {results.length === 0 ? (
                <li className="px-1 py-6 text-[13.5px] text-muted">No pages match &ldquo;{query}&rdquo;.</li>
              ) : (
                // Several distinct entries share a real url on purpose (e.g.
                // Leasing/Payments/Services all point at the same in-page
                // anchor) — key by title+url, not url alone, or React drops
                // the "duplicate" siblings.
                results.map((item, i) => (
                  <li key={`${item.title}-${item.url}`}>
                    <Dialog.Close asChild>
                      <a
                        href={item.url}
                        data-attr="public-search-result"
                        onMouseEnter={() => setSelectedIndex(i)}
                        onClick={(e) => {
                          e.preventDefault();
                          openResult(item);
                        }}
                        className={cn(
                          "flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-[14.5px] text-foreground transition-colors",
                          i === selectedIndex ? "bg-accent" : "hover:bg-accent/60",
                        )}
                      >
                        <span className="font-medium">{item.title}</span>
                        <span className="shrink-0 text-[11.5px] text-muted">{item.group}</span>
                      </a>
                    </Dialog.Close>
                  </li>
                ))
              )}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
