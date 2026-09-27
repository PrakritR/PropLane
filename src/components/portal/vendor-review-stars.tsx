"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/** Accessible 1–5 star radio group — the manager's "Leave a review" input. */
export function VendorReviewStarPicker({
  value,
  onChange,
  disabled,
  dataAttr,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Rate 1 to 5 stars">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = n <= value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            disabled={disabled}
            className="flex h-11 w-11 items-center justify-center rounded-full transition active:scale-95 disabled:opacity-50"
            data-attr={dataAttr ? `${dataAttr}-${n}` : undefined}
            onClick={() => onChange(n)}
          >
            <Star
              className={cn("h-7 w-7 transition-colors", on ? "fill-primary text-primary" : "text-foreground/25")}
              strokeWidth={1.5}
              aria-hidden
            />
          </button>
        );
      })}
    </div>
  );
}

/** Small read-only star row for a review list item — plain text glyphs, never an icon component. */
export function VendorReviewStarDisplay({ stars, size = "sm" }: { stars: number; size?: "sm" | "md" }) {
  const textSize = size === "sm" ? "text-[13px]" : "text-base";
  const filled = Math.max(0, Math.min(5, Math.round(stars)));
  const glyphs = "★".repeat(filled) + "☆".repeat(5 - filled);
  return (
    <span
      className={cn("inline-flex items-center leading-none tracking-[1px] text-primary", textSize)}
      role="img"
      aria-label={`${stars} out of 5 stars`}
    >
      {glyphs}
    </span>
  );
}
