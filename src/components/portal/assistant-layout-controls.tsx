"use client";

import { ChevronsLeft } from "lucide-react";

import { cn } from "@/lib/utils";

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
