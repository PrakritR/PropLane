"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/** A row of five star glyphs, `stars` of them filled. Plain facts with a glyph, never a pill. */
export function RatingStars({ stars, className }: { stars: number; className?: string }) {
  const whole = Math.round(stars);
  return (
    <span
      role="img"
      aria-label={`${stars} of 5 stars`}
      className={cn("inline-flex items-center gap-0.5 text-[var(--status-pending-fg)]", className)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} aria-hidden className={cn("size-[14px]", n <= whole ? "fill-current" : "fill-none opacity-35")} />
      ))}
    </span>
  );
}

/** The 1-5 star picker: a radio group of star buttons, keyboard reachable, 44px tap targets on a phone. */
export function RatingStarInput({
  value,
  onChange,
  disabled,
  dataAttr,
}: {
  value: number;
  onChange: (stars: number) => void;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <div role="radiogroup" aria-label="Rating" className="flex items-center gap-1" data-attr={dataAttr}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
          disabled={disabled}
          onClick={() => onChange(n)}
          className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--status-pending-fg)] outline-none transition hover:bg-[var(--secondary)]/70 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50 md:size-9"
        >
          <Star aria-hidden className={cn("size-6", n <= value ? "fill-current" : "fill-none opacity-35")} />
        </button>
      ))}
    </div>
  );
}
