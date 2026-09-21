"use client";

import { AppWindow, ChevronsLeft, PanelRight } from "lucide-react";

import { cn } from "@/lib/utils";

const iconBtnClass =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25";

export function AssistantDockToRailButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Dock assistant to the right side"
      title="Dock to right side"
      data-attr="assistant-dock-to-rail"
      className={cn(iconBtnClass, className)}
    >
      <PanelRight className="h-4 w-4" aria-hidden />
    </button>
  );
}

export function AssistantDockExpandButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Expand PropLane Assistant"
      aria-expanded={false}
      data-attr="portal-assistant-dock-expand"
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-muted transition-colors duration-150 hover:bg-[var(--secondary)]/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        className,
      )}
    >
      <ChevronsLeft className="h-4 w-4" aria-hidden />
    </button>
  );
}

export function AssistantUndockToPopupButton({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Unpin PropLane Assistant, use the floating popup instead"
      title="Unpin — back to the floating popup"
      data-attr="assistant-undock-to-popup"
      className={cn(iconBtnClass, className)}
    >
      <AppWindow className="h-4 w-4" aria-hidden />
    </button>
  );
}
