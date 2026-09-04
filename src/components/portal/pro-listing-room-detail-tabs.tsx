"use client";

import { cn } from "@/lib/utils";

export type ListingRoomDetailTabId = "preview" | "move-in-details";

export const LISTING_ROOM_DETAIL_TAB_LABELS: Record<ListingRoomDetailTabId, string> = {
  preview: "Preview",
  "move-in-details": "Move-in details",
};

export function ListingRoomDetailTabToggle({
  value,
  onChange,
  className,
}: {
  value: ListingRoomDetailTabId;
  onChange: (next: ListingRoomDetailTabId) => void;
  className?: string;
}) {
  const options: { value: ListingRoomDetailTabId; label: string }[] = [
    { value: "preview", label: LISTING_ROOM_DETAIL_TAB_LABELS.preview },
    { value: "move-in-details", label: LISTING_ROOM_DETAIL_TAB_LABELS["move-in-details"] },
  ];

  return (
    <div
      role="tablist"
      aria-label="Room section"
      className={cn(
        "inline-grid min-h-[40px] grid-flow-col auto-cols-fr items-stretch rounded-2xl border border-border bg-card p-1",
        className,
      )}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-attr={`listing-room-tab-${opt.value}`}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center justify-center rounded-xl px-3 text-center text-xs font-medium transition-colors",
              active ? "bg-primary/10 text-primary" : "text-muted hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
