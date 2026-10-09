import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One stat on the strip: a plain label over a figure. The figure is always a
 * number the page already derives (a bucket total, a balance) - the strip adds
 * no figure of its own.
 */
export type PortalStat = {
  id: string;
  label: string;
  value: ReactNode;
  /** Lands on the figure itself, so a test or an analytics hook reads exactly the number. */
  dataAttr?: string;
  /** "danger" draws the figure in the overdue red, "ok" in green (text colour only). */
  tone?: "danger" | "ok";
  /** Makes the whole card a link (a balance that opens the page behind it). */
  href?: string;
  /** A fact the page already says about this figure (a held reason), in small muted text. */
  note?: ReactNode;
};

/**
 * The hairline stat cards that sit above a money list's rows: label in 13px
 * muted, figure in 20px semibold, one card per bucket / balance. The grid fits
 * as many columns as the width allows (never fewer than a readable card), so
 * three buckets share one row on a desktop and wrap on a phone.
 */
export function PortalStatStrip({
  items,
  className,
  dataAttr = "portal-stat-strip",
  size = "md",
}: {
  items: readonly PortalStat[];
  className?: string;
  dataAttr?: string;
  /** `lg` is the Finances KPI row: a 26px figure instead of the list strip's 20px. */
  size?: "md" | "lg";
}) {
  if (items.length === 0) return null;
  return (
    <div
      className={cn("grid gap-3 max-md:grid-cols-2 max-md:gap-2 md:[grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr))]", className)}
      data-slot="portal-stat-strip"
      data-attr={dataAttr}
    >
      {items.map((item) => {
        const card = (
          <>
            <div className="truncate text-[13px] font-medium text-muted">{item.label}</div>
            <div
              className={cn(
                "mt-0.5 truncate font-semibold leading-tight tabular-nums",
                size === "lg" ? "text-[26px] tracking-[-0.03em]" : "text-[20px] tracking-[-0.02em]",
                item.tone === "danger" ? "text-[var(--status-overdue-fg)]" : item.tone === "ok" ? "text-[var(--status-confirmed-fg)]" : "text-foreground",
              )}
              data-attr={item.dataAttr}
            >
              {item.value}
            </div>
            {item.note ? <div className="mt-0.5 text-xs text-muted">{item.note}</div> : null}
          </>
        );
        const cardClass = cn(
          "block min-w-0 rounded-[10px] border border-border bg-card",
          size === "lg" ? "px-4 py-3.5" : "px-3.5 py-2.5",
          item.href && "transition-colors hover:border-foreground/25",
        );
        return item.href ? (
          <Link key={item.id} href={item.href} className={cardClass} data-slot="portal-stat">
            {card}
          </Link>
        ) : (
          <div key={item.id} className={cardClass} data-slot="portal-stat">
            {card}
          </div>
        );
      })}
    </div>
  );
}
