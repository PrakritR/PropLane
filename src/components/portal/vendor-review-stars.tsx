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

/** Small read-only star row for a review list item. */
export function VendorReviewStarDisplay({ stars, size = "sm" }: { stars: number; size?: "sm" | "md" }) {
  const dimension = size === "sm" ? "h-3.5 w-3.5" : "h-4.5 w-4.5";
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${stars} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn(dimension, n <= stars ? "fill-primary text-primary" : "text-foreground/20")}
          strokeWidth={1.5}
          aria-hidden
        />
      ))}
    </span>
  );
}
