"use client";

import { useMemo, useState } from "react";
import "./journey-forms.css";

export type JourneyPickerOption = {
  id: string;
  title: string;
  /** Plain place line under the title. */
  place?: string;
  /** Right-hand figure, e.g. a rent. */
  figure?: string;
  /** Extra text matched by search. */
  searchText?: string;
};

/**
 * The prospect journey's picker: a search box over a hairline list. A row is a title, a place line and a
 * figure, never a chip. Picks call `onChange` with the row id.
 */
export function JourneyPicker({
  options,
  value,
  onChange,
  placeholder,
  ariaLabel,
  emptyMessage,
  listEmptyMessage,
  searchAbove = 6,
}: {
  options: JourneyPickerOption[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
  ariaLabel: string;
  emptyMessage: string;
  listEmptyMessage: string;
  /** The search box only shows once the list is longer than this. */
  searchAbove?: number;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      [o.title, o.place, o.figure, o.searchText].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [options, query]);

  return (
    <div className="ps-j-stack" style={{ gap: 12 }}>
      {options.length > searchAbove ? (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="ps-input ps-j-search"
        />
      ) : null}
      {options.length === 0 ? (
        <p className="ps-j-empty">{listEmptyMessage}</p>
      ) : filtered.length === 0 ? (
        <p className="ps-j-empty">{emptyMessage}</p>
      ) : (
        <ul className="ps-j-list">
          {filtered.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className="ps-j-row"
                aria-pressed={value === o.id}
                onClick={() => onChange(o.id)}
              >
                <span>
                  <span className="ps-j-row-t">{o.title}</span>
                  {o.place ? <span className="ps-j-row-s">{o.place}</span> : null}
                </span>
                {o.figure ? <span className="ps-j-row-r">{o.figure}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
