"use client";

import { useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type PropertySearchOption = {
  id: string;
  title: string;
  subtitle?: string;
  tags?: string[];
  /** Optional listing hero thumbnail for browse / picker cards. */
  imageUrl?: string;
  /** Extra text included when filtering (address, neighborhood, etc.). */
  searchText?: string;
};

const DEFAULT_PREVIEW_LIMIT = 50;

function normalizeSearchHaystack(option: PropertySearchOption): string {
  return [option.title, option.subtitle, option.searchText, ...(option.tags ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

function CheckSmIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex rounded-full border border-border/60 bg-accent/50 px-2.5 py-0.5 text-[11px] font-medium text-muted">
      {children}
    </span>
  );
}

const inputCls =
  "w-full rounded-2xl border border-border/60 bg-[var(--glass-fill)] py-3 pl-10 pr-4 text-sm text-foreground outline-none transition-all placeholder:text-muted/60 focus:border-primary/30 focus:bg-card focus:ring-2 focus:ring-primary/25 hover:bg-card/80";

export function PropertySearchPicker({
  options,
  value,
  onChange,
  placeholder = "Search by address, neighborhood, or property name…",
  emptyMessage = "No properties match your search.",
  listEmptyMessage = "No properties available right now.",
  previewLimit = DEFAULT_PREVIEW_LIMIT,
  ariaLabel = "Search properties",
  itemNoun = "property",
  itemNounPlural = "properties",
  /** Let the option list grow inside a tall modal instead of capping at 18rem. */
  listFillsAvailableHeight = false,
  className,
}: {
  options: PropertySearchOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  emptyMessage?: string;
  listEmptyMessage?: string;
  previewLimit?: number;
  ariaLabel?: string;
  /**
   * What the rows actually are. The tour flow lists the ROOMS of one property,
   * so the hard-coded "2 properties" above two rooms of a single home was
   * simply wrong.
   */
  itemNoun?: string;
  itemNounPlural?: string;
  listFillsAvailableHeight?: boolean;
  className?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);
  const displayQuery = selected && !focused ? "" : query;

  const filtered = useMemo(() => {
    const q = displayQuery.trim().toLowerCase();
    const matched = q
      ? options.filter((o) => normalizeSearchHaystack(o).includes(q))
      : options;
    const limited = q ? matched : matched.slice(0, previewLimit);
    return {
      items: limited,
      total: matched.length,
      truncated: !q && matched.length > previewLimit,
    };
  }, [options, previewLimit, displayQuery]);

  const showList = focused || displayQuery.length > 0 || !selected;

  return (
    <div
      className={cn(
        listFillsAvailableHeight ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3",
        className,
      )}
    >
      <div className="relative">
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted/60">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="search"
          value={displayQuery}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            window.setTimeout(() => setFocused(false), 120);
          }}
          placeholder={selected && !focused && !displayQuery ? selected.title : placeholder}
          aria-label={ariaLabel}
          aria-controls={listId}
          className={inputCls}
        />
        {selected ? (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
              inputRef.current?.focus();
            }}
            className="link-premium absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary"
          >
            Change
          </button>
        ) : null}
      </div>

      {selected && !showList ? (
        <div className="glass-card rounded-2xl border border-primary/25 bg-primary/5 p-4 ring-2 ring-primary/10">
          <p className="text-sm font-semibold text-foreground">{selected.title}</p>
          {selected.subtitle ? <p className="mt-0.5 text-xs text-muted">{selected.subtitle}</p> : null}
          {selected.tags && selected.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {selected.tags.map((tag) => (
                <Chip key={tag}>{tag}</Chip>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {showList ? (
        <div className={cn(listFillsAvailableHeight ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2")}>
          {options.length === 0 ? (
            <div className="glass-card rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">
              {listEmptyMessage}
            </div>
          ) : (
            <>
              <p className="text-xs text-muted">
                {displayQuery.trim()
                  ? `${filtered.total} ${filtered.total === 1 ? "match" : "matches"}`
                  : filtered.truncated
                    ? `Showing ${filtered.items.length} of ${filtered.total} ${itemNounPlural}. Search to find yours faster`
                    : `${filtered.total} ${filtered.total === 1 ? itemNoun : itemNounPlural}`}
              </p>
              <ul
                id={listId}
                role="listbox"
                aria-label={ariaLabel}
                className={cn(
                  "space-y-2 overflow-y-auto overscroll-contain pr-1",
                  listFillsAvailableHeight ? "min-h-0 flex-1" : "max-h-72",
                )}
              >
                {filtered.items.length === 0 ? (
                  <li className="glass-card rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
                    {emptyMessage}
                  </li>
                ) : (
                  filtered.items.map((option) => {
                    const isSelected = value === option.id;
                    return (
                      <li key={option.id} role="option" aria-selected={isSelected}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            onChange(option.id);
                            setQuery("");
                            setFocused(false);
                            inputRef.current?.blur();
                          }}
                          className={`w-full rounded-2xl border p-4 text-left transition-all duration-150 ${
                            isSelected
                              ? "glass-card border-primary/30 bg-primary/5 ring-2 ring-primary/20"
                              : "border-border bg-card hover:border-primary/20 hover:bg-accent/30"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-foreground">{option.title}</p>
                              {option.subtitle ? (
                                <p className="mt-0.5 truncate text-xs text-muted">{option.subtitle}</p>
                              ) : null}
                              {option.tags && option.tags.length > 0 ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {option.tags.map((tag) => (
                                    <Chip key={tag}>{tag}</Chip>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            {/* Rendered as a span, not a button: the whole row is already the
                                control (and a listbox option), so a nested button would be
                                invalid markup and a second, redundant tab stop. */}
                            <span
                              aria-hidden
                              className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border px-4 text-[13px] font-semibold transition-colors ${
                                isSelected
                                  ? "border-primary bg-primary text-white"
                                  : "border-primary/40 bg-card text-primary"
                              }`}
                            >
                              {isSelected ? <CheckSmIcon /> : null}
                              Select
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function buildingGroupsToSearchOptions(
  buildings: {
    buildingId: string;
    buildingName: string;
    address: string;
    neighborhood: string;
    units: unknown[];
  }[],
): PropertySearchOption[] {
  return buildings.map((b) => {
    const count = b.units.length;
    return {
      id: b.buildingId,
      title: b.buildingName,
      subtitle: b.address,
      tags: [b.neighborhood, `${count} ${count === 1 ? "room" : "rooms"} available`],
      searchText: `${b.buildingName} ${b.address} ${b.neighborhood}`,
    };
  });
}
