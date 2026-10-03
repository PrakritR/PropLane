"use client";

import { sharedRoomBedRowsFromSlots } from "@/lib/public-shared-room-listing";
import type { OpenResidentSlot } from "@/lib/rental-application/room-occupancy";

export function ListingSharedRoomBeds({ slots }: { slots: OpenResidentSlot[] }) {
  if (!slots.length) return null;
  const rows = sharedRoomBedRowsFromSlots(slots);
  return (
    <ul className="space-y-2" data-sr-beds>
      {rows.map((row) => (
        <li
          key={row.slot}
          className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
        >
          <span className="min-w-0">
            <span className="block text-sm font-bold text-foreground">{row.label}</span>
            <span className="block text-xs font-semibold text-muted">{row.priceLabel}</span>
          </span>
          <span
            className={`shrink-0 text-xs font-semibold ${row.available ? "text-[var(--status-confirmed-fg)]" : "text-muted"}`}
          >
            {row.statusLabel}
          </span>
        </li>
      ))}
    </ul>
  );
}
