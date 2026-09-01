"use client";

import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Docked bottom bar when list rows are selected — replaces invisible bulk affordances. */
export function BulkActionBar({
  count,
  children,
  className,
  /** Mirrors payment ledger list gutters so actions line up with amount column. */
  variant = "default",
  /** Hide the "{n} selected" label (tours bulk bar shows actions only). */
  hideCount = false,
  /** Override the default "{count} selected" label. */
  countLabel,
}: {
  count: number;
  children: ReactNode;
  className?: string;
  variant?: "default" | "payments";
  hideCount?: boolean;
  countLabel?: (count: number) => string;
}) {
  useEffect(() => {
    if (count <= 0) return;
    document.documentElement.setAttribute("data-bulk-action-bar", "");
    if (variant !== "default") {
      document.documentElement.setAttribute("data-bulk-action-variant", variant);
    }
    return () => {
      document.documentElement.removeAttribute("data-bulk-action-bar");
      document.documentElement.removeAttribute("data-bulk-action-variant");
    };
  }, [count, variant]);

  if (count <= 0) return null;

  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-[51] border-t border-border bg-card/95 px-3 py-2.5 shadow-[var(--shadow-lg)] backdrop-blur-md sm:px-4 sm:py-3",
        "pb-[max(0.75rem,var(--native-safe-bottom))]",
        "max-lg:inset-x-2.5 max-lg:bottom-[calc(var(--portal-native-bottom-nav-inset,0px)+var(--portal-floating-bottom-gap,1.25rem))] max-lg:rounded-2xl max-lg:border max-lg:py-3 max-lg:pb-3 max-lg:shadow-md",
        variant === "payments" && "lg:left-[224px] lg:right-0",
        className,
      )}
      data-slot="bulk-action-bar"
      data-variant={variant}
      role="region"
      aria-label={count === 1 ? "Bulk actions, 1 item selected" : `Bulk actions, ${count} items selected`}
    >
      {variant === "payments" ? (
        <div className="flex w-full min-w-0 items-center overflow-hidden px-2.5 max-md:px-0 sm:px-4 lg:px-5" data-portal-action-slot="">
          <div className="relative min-w-0 w-full flex-1 overflow-hidden">{children}</div>
        </div>
      ) : (
        <div
          className={cn(
            "mx-auto flex w-full max-w-5xl min-w-0 flex-nowrap items-center",
            hideCount ? "justify-start gap-2" : "gap-5 sm:gap-6",
          )}
        >
          {!hideCount ? (
            <p className="shrink-0 text-[10px] font-semibold tabular-nums text-foreground sm:text-[11px]">
              {countLabel ? countLabel(count) : `${count} selected`}
            </p>
          ) : null}
          <div className={cn("relative min-w-0", hideCount ? undefined : "flex-1")}>{children}</div>
        </div>
      )}
    </div>
  );
}
