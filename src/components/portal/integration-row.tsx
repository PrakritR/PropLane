"use client";

import { ChevronRight } from "lucide-react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One integration, one row: logo tile · name · one plain fact · action.
 * A channel that is not built yet says "Coming soon" in plain text where the
 * action would be - never a badge or a pill (portal rows carry none).
 */
export function IntegrationRow({
  icon: Icon,
  tone,
  name,
  fact,
  factDataAttr,
  action,
  comingSoon,
  comingSoonAction,
  dataAttr,
  itemDataAttr,
  className,
  onOpen,
}: {
  icon: ComponentType<{ className?: string }>;
  /** Tailwind text color for the logo glyph. */
  tone?: string;
  name: string;
  fact?: ReactNode;
  factDataAttr?: string;
  action?: ReactNode;
  comingSoon?: boolean;
  /** An action that sits beside "Coming soon" (Request access); only drawn while `comingSoon`. */
  comingSoonAction?: ReactNode;
  dataAttr?: string;
  /**
   * The per-item PostHog name, beside the shared `dataAttr`: a list whose rows all share one
   * `data-attr` cannot tell a funnel WHICH row was opened.
   */
  itemDataAttr?: string;
  className?: string;
  /** Makes the whole row open something (a guide, a drawer) and draws a trailing chevron. */
  onOpen?: () => void;
}) {
  return (
    <div
      data-attr={dataAttr}
      data-item-attr={itemDataAttr}
      className={cn("flex min-h-14 items-center gap-3 border-b border-border px-4 py-2 last:border-0", onOpen && "cursor-pointer hover:bg-foreground/5", className)}
      {...(onOpen
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-label": name,
            onClick: onOpen,
            onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/60" aria-hidden>
        <Icon className={cn("size-5", tone ?? "text-muted")} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] text-foreground">{name}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {fact && !comingSoon ? (
          <span className="text-xs text-muted" data-attr={factDataAttr}>
            {fact}
          </span>
        ) : null}
        {comingSoon ? (
          <>
            <span className="text-sm text-muted">Coming soon</span>
            {comingSoonAction}
          </>
        ) : (
          action
        )}
        {onOpen ? <ChevronRight className="size-4 text-muted" aria-hidden /> : null}
      </div>
    </div>
  );
}
