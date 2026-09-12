"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The floating bulk bar — a dark pill that appears above the list while rows
 * are selected: "2 selected · Unlist · Share · Delete · ✕", the way Linear and
 * Notion surface bulk actions. It used to be a full-width light dock; the pill
 * reads as a temporary tool rather than a second footer, and the count is the
 * anchor the actions hang off, so it is shown here regardless of `hideCount`
 * (kept for the call sites that pass it).
 *
 * `placement="list-pane"` keeps the older in-flow footer for Communication's
 * left column, which has its own scroll container.
 */
export function BulkActionBar({
  count,
  children,
  className,
  /** Kept for callers; the pill no longer differs by variant. */
  variant = "default",
  /** Accepted for callers; the pill always leads with the count. */
  hideCount = false,
  /** Override the default "{count} selected" label. */
  countLabel,
  /**
   * `viewport` — floating pill above the portal bottom (default).
   * `list-pane` — in-flow footer inside Communication's left list column only.
   */
  placement = "viewport",
  /** Clears the selection — renders the ✕ at the end of the pill. */
  onClear,
}: {
  count: number;
  children: ReactNode;
  className?: string;
  variant?: "default" | "payments";
  hideCount?: boolean;
  countLabel?: (count: number) => string;
  placement?: "viewport" | "list-pane";
  onClear?: () => void;
}) {
  const listPane = placement === "list-pane";
  void hideCount;

  useEffect(() => {
    if (listPane || count <= 0) return;
    document.documentElement.setAttribute("data-bulk-action-bar", "");
    if (variant !== "default") {
      document.documentElement.setAttribute("data-bulk-action-variant", variant);
    }
    return () => {
      document.documentElement.removeAttribute("data-bulk-action-bar");
      document.documentElement.removeAttribute("data-bulk-action-variant");
    };
  }, [count, listPane, variant]);

  if (count <= 0) return null;

  const label = countLabel ? countLabel(count) : `${count} selected`;

  if (listPane) {
    return (
      <div
        className={cn(
          "relative shrink-0 border-t border-border bg-card/95 px-3 py-2.5 shadow-[var(--shadow-sm)] backdrop-blur-md sm:px-4",
          className,
        )}
        data-slot="bulk-action-bar"
        data-variant={variant}
        role="region"
        aria-label={count === 1 ? "Bulk actions, 1 item selected" : `Bulk actions, ${count} items selected`}
      >
        <div className="flex w-full min-w-0 flex-nowrap items-center gap-3">
          <p className="shrink-0 text-[11px] font-semibold tabular-nums text-foreground">{label}</p>
          <div className="relative min-w-0 flex-1">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        // Centred over the content column (the sidebar is 224px on desktop),
        // above the assistant FAB (z-55) so every action stays clickable.
        "pointer-events-none fixed inset-x-0 z-[56] flex justify-center px-3",
        "bottom-[calc(var(--portal-native-bottom-nav-inset,0px)+var(--portal-floating-bottom-gap,1.25rem)+env(safe-area-inset-bottom,0px))] lg:bottom-6",
        variant === "payments" && "lg:left-[224px]",
        className,
      )}
      data-slot="bulk-action-bar"
      data-variant={variant}
      role="region"
      aria-label={count === 1 ? "Bulk actions, 1 item selected" : `Bulk actions, ${count} items selected`}
    >
      <div
        className={cn(
          "pointer-events-auto flex max-w-full min-w-0 items-center gap-1 rounded-full bg-foreground py-1.5 pl-4 pr-1.5 text-background shadow-[0_12px_32px_-8px_rgba(11,27,58,0.45)]",
          // The actions are ordinary outline Buttons; on the dark pill they wear
          // a light hairline and light text, and a danger action reads rose.
          "[&_button]:!h-9 [&_button]:!min-h-0 [&_button]:!rounded-full [&_button]:!border-background/25 [&_button]:!bg-transparent [&_button]:!px-3 [&_button]:!text-[13px] [&_button]:!text-background [&_button]:!shadow-none [&_button:hover]:!bg-background/15",
          "[&_.portal-danger-outline]:!border-rose-300/50 [&_.portal-danger-outline]:!text-rose-200 [&_.portal-danger-outline:hover]:!bg-rose-400/20",
        )}
      >
        <p className="mr-2 shrink-0 whitespace-nowrap text-[13px] font-semibold tabular-nums">{label}</p>
        <div
          className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {children}
        </div>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selection"
            data-attr="bulk-bar-clear"
            className="ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-background/80 hover:bg-background/15 hover:text-background"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
