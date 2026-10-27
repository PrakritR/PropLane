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
  className,
  onOpen,
  stackOnPhone,
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
  className?: string;
  /** Makes the whole row open something (a guide, a drawer) and draws a trailing chevron. */
  onOpen?: () => void;
  /**
   * On a phone the fact and action drop to a second line under the name (indented past the logo tile), so a long
   * fact or a listing picker never overlaps the name and the action never leaves the screen.
   */
  stackOnPhone?: boolean;
}) {
  return (
    <div
      data-attr={dataAttr}
      className={cn("flex min-h-14 items-center gap-3 border-b border-border px-4 py-2 last:border-0", stackOnPhone && "max-sm:flex-wrap", onOpen && "cursor-pointer hover:bg-foreground/5", className)}
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
        <p className="min-w-[6rem] truncate text-[15px] text-foreground">{name}</p>
      </div>
      {/* "Coming soon" and its action stack on a phone so the name keeps its width instead of shrinking to a letter. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          comingSoon && comingSoonAction ? "max-sm:flex-col max-sm:items-end max-sm:gap-0.5" : null,
          stackOnPhone && "max-sm:w-full max-sm:shrink max-sm:basis-full max-sm:pl-12",
        )}
        data-integration-actions={stackOnPhone ? "stacked" : undefined}
      >
        {fact && !comingSoon ? (
          <span className={cn("text-xs text-muted", stackOnPhone && "max-sm:min-w-0 max-sm:flex-1")} data-attr={factDataAttr}>
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
