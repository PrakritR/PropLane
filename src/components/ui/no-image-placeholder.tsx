import { House, ImageIcon, ImageOff } from "lucide-react";

/**
 * Neutral "no photo" tile for production listings/rooms with zero genuine
 * uploaded photos. Never substitute stock/fabricated imagery for a real
 * listing — a prospective tenant would be misled into thinking it's a photo
 * of the actual unit. Absolutely positioned to fill a `relative` image slot,
 * same as the `next/image` `fill` it replaces.
 *
 * `variant="branded"` is the calmer, first-impression treatment for browse
 * cards: a soft branded wash and a plain image glyph that reads "no photo yet"
 * rather than the default's crossed-out "broken image" icon. It still clearly
 * communicates the absence of a photo — it does not fabricate one.
 *
 * `variant="compact"` is the honest tile the redesigned browse cards, room
 * rows and detail page use: a flat neutral fill, a small house outline and
 * "No photos yet". It is deliberately quiet so an empty slot never becomes the
 * largest element on the screen (PLAN-0914-2124). `label=""` hides the text for
 * thumbnails too small to carry it.
 */
export function NoImagePlaceholder({
  className = "",
  label,
  variant = "default",
}: {
  className?: string;
  label?: string;
  variant?: "default" | "branded" | "compact";
}) {
  const branded = variant === "branded";
  const compact = variant === "compact";
  const resolvedLabel = label ?? (compact ? "No photos yet" : branded ? "Photo coming soon" : "No image");
  if (compact) {
    return (
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[var(--pl-surface-muted,#f4f5f8)] text-muted ${className}`}
        role="img"
        aria-label={resolvedLabel || "No photos yet"}
      >
        <House className="h-5 w-5 opacity-60" strokeWidth={1.75} aria-hidden />
        {resolvedLabel ? <span className="text-xs font-semibold">{resolvedLabel}</span> : null}
      </div>
    );
  }
  return (
    <div
      className={`absolute inset-0 flex flex-col items-center justify-center gap-2 ${
        branded
          ? "bg-gradient-to-br from-accent/25 via-accent/15 to-primary/10 text-muted"
          : "bg-accent/40 text-muted"
      } ${className}`}
      role="img"
      aria-label={resolvedLabel}
    >
      {branded ? (
        <ImageIcon className="h-6 w-6 opacity-45" strokeWidth={1.5} aria-hidden />
      ) : (
        <ImageOff className="h-8 w-8" strokeWidth={1.5} aria-hidden />
      )}
      <span className={`text-xs font-medium ${branded ? "opacity-70" : ""}`}>{resolvedLabel}</span>
    </div>
  );
}
