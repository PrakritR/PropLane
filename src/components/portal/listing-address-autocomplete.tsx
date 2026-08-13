"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import type { AddressSuggestion } from "@/lib/geocode-address";
import { sanitizeStreetAddressInput } from "@/lib/listing-form-inputs";

type ListingAddressAutocompleteProps = {
  value: string;
  onChange: (address: string) => void;
  onSelect: (suggestion: AddressSuggestion) => void;
  className?: string;
  placeholder?: string;
  "aria-invalid"?: boolean;
};

export function ListingAddressAutocomplete({
  value,
  onChange,
  onSelect,
  className,
  placeholder = "Start typing a street address…",
  "aria-invalid": ariaInvalid,
}: ListingAddressAutocompleteProps) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const skipNextFetch = useRef(false);

  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 4) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void fetch(`/api/geocode/suggest?q=${encodeURIComponent(q)}`, { cache: "no-store" })
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as { suggestions?: AddressSuggestion[] };
          if (cancelled) return;
          setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
          setOpen(true);
          setActiveIndex(-1);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 320);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const applySuggestion = (suggestion: AddressSuggestion) => {
    skipNextFetch.current = true;
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
    onSelect(suggestion);
  };

  return (
    <div ref={wrapRef} className="relative">
      <Input
        value={value}
        autoComplete="street-address"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open && suggestions.length > 0}
        aria-invalid={ariaInvalid}
        className={className}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(sanitizeStreetAddressInput(e.target.value));
          setOpen(true);
        }}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open || suggestions.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => (i + 1) % suggestions.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
          } else if (e.key === "Enter" && activeIndex >= 0) {
            e.preventDefault();
            const hit = suggestions[activeIndex];
            if (hit) applySuggestion(hit);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {loading ? (
        <p className="mt-1 text-[11px] text-muted">Searching addresses…</p>
      ) : null}
      {open && suggestions.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-white/20 bg-[#1c2433] py-1 shadow-2xl [html[data-theme=light]_&]:border-border [html[data-theme=light]_&]:bg-white"
        >
          {suggestions.map((suggestion, index) => {
            const active = index === activeIndex;
            return (
              <li key={suggestion.id} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={`block w-full px-3 py-2 text-left text-sm leading-snug ${
                    active ? "bg-primary/10 text-foreground" : "text-foreground hover:bg-accent/40"
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => applySuggestion(suggestion)}
                >
                  <span className="font-medium">{suggestion.address || suggestion.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted">
                    {[suggestion.city, suggestion.state, suggestion.zip].filter(Boolean).join(" · ")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
