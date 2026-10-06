"use client";

import type { ComponentType, ReactNode } from "react";

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
  dataAttr,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  /** Tailwind text color for the logo glyph. */
  tone?: string;
  name: string;
  fact?: ReactNode;
  factDataAttr?: string;
  action?: ReactNode;
  comingSoon?: boolean;
  dataAttr?: string;
  className?: string;
}) {
  return (
    <div
      data-attr={dataAttr}
      className={cn("flex min-h-14 items-center gap-3 border-b border-border px-4 py-2 last:border-0", className)}
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
        {comingSoon ? <span className="text-sm text-muted">Coming soon</span> : action}
      </div>
    </div>
  );
}
