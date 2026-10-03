"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteRoomDateBlock,
  fetchRoomDateBlocks,
  ROOM_DATE_BLOCKS_CHANGED,
  saveRoomDateBlock,
} from "@/lib/channel-calendar/room-date-blocks";
import type { RoomDateBlock } from "@/lib/channel-calendar/property-bookings";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";

function managerBlocksForRoom(blocks: RoomDateBlock[], propertyId: string, roomId: string): RoomDateBlock[] {
  return blocks.filter(
    (b) =>
      b.propertyId === propertyId &&
      b.roomId === roomId &&
      b.bookingStatus === "hold" &&
      !b.isBookingResidency,
  );
}

export function BlockedDatesSection({
  propertyId,
  roomId,
  managerUserId,
  showToast,
}: {
  propertyId: string | null | undefined;
  roomId: string;
  managerUserId: string | null;
  showToast?: (message: string) => void;
}) {
  const [blocks, setBlocks] = useState<RoomDateBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [openEnded, setOpenEnded] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!propertyId) {
      setBlocks([]);
      return;
    }
    setLoading(true);
    fetchRoomDateBlocks()
      .then((rows) => setBlocks(managerBlocksForRoom(rows, propertyId, roomId)))
      .catch(() => showToast?.("Could not load blocked dates."))
      .finally(() => setLoading(false));
  }, [propertyId, roomId, showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener(ROOM_DATE_BLOCKS_CHANGED, onChange);
    return () => window.removeEventListener(ROOM_DATE_BLOCKS_CHANGED, onChange);
  }, [refresh]);

  const rows = useMemo(() => blocks.sort((a, b) => a.checkIn.localeCompare(b.checkIn)), [blocks]);

  const addBlock = async () => {
    if (!propertyId || !managerUserId) {
      showToast?.("Save the property before blocking dates.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) {
      showToast?.("Pick a move-in date.");
      return;
    }
    if (!openEnded && !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      showToast?.("Pick a move-out date or mark open-ended.");
      return;
    }
    setBusy(true);
    try {
      await saveRoomDateBlock(managerUserId, {
        propertyId,
        roomId,
        checkIn,
        checkOut: openEnded ? checkOut || checkIn : checkOut,
        openEnded,
        reason: "Blocked by manager",
        bookingStatus: "hold",
      });
      setCheckIn("");
      setCheckOut("");
      setOpenEnded(false);
      refresh();
    } catch (e) {
      showToast?.(e instanceof Error ? e.message : "Could not block those dates.");
    } finally {
      setBusy(false);
    }
  };

  if (!propertyId) {
    return (
      <p className="px-3.5 py-2 text-[13px] text-muted" data-attr="room-blocked-dates-unsaved">
        Save this listing before blocking dates.
      </p>
    );
  }

  return (
    <div className="space-y-3 px-3.5 py-2" data-attr="room-blocked-dates">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-foreground">Blocked dates</span>
      </div>
      {loading ? <p className="text-xs text-muted">Loading…</p> : null}
      {rows.length === 0 && !loading ? <p className="text-xs text-muted">No blocked dates yet.</p> : null}
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-[13px]"
          >
            <span>
              {row.checkIn} → {row.openEnded ? "Open-ended" : row.checkOut}
            </span>
            <RowActionsMenu
              label="Blocked span"
              items={[
                {
                  id: "remove",
                  label: "Remove",
                  danger: true,
                  onSelect: () => {
                    void deleteRoomDateBlock(row.id)
                      .then(() => refresh())
                      .catch(() => showToast?.("Could not remove that block."));
                  },
                },
              ]}
            />
          </li>
        ))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input type="date" aria-label="Move-in" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
        <Input
          type="date"
          aria-label="Move-out"
          value={checkOut}
          disabled={openEnded}
          onChange={(e) => setCheckOut(e.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={openEnded} onChange={(e) => setOpenEnded(e.target.checked)} />
        Open-ended
      </label>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void addBlock()} data-attr="room-blocked-dates-add">
        + Block dates
      </Button>
    </div>
  );
}
