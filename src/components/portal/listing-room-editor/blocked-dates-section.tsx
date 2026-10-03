"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
      showToast?.("Pick an end date.");
      return;
    }
    if (checkOut < checkIn) {
      showToast?.("The end date is before the start date.");
      return;
    }
    setBusy(true);
    try {
      await saveRoomDateBlock(managerUserId, {
        propertyId,
        roomId,
        checkIn,
        checkOut,
        openEnded: false,
        reason: "Blocked by manager",
        bookingStatus: "hold",
      });
      setCheckIn("");
      setCheckOut("");
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

  const shortDate = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return y && m && d ? new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : iso;
  };

  return (
    <div className="space-y-3 px-3.5 py-2" data-attr="room-blocked-dates">
      {/* Captain, Oct 3: the add is a round + beside the heading; no Open-ended. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-foreground">Blocked dates</span>
        <PortalPrimaryIconAction
          label="Block dates"
          disabled={busy}
          onClick={() => void addBlock()}
          data-attr="room-blocked-dates-add"
        />
      </div>
      {loading ? <p className="text-xs text-muted">Loading…</p> : null}
      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-[13px]"
            >
              <span>
                {shortDate(row.checkIn)} → {row.openEnded ? "Open-ended" : shortDate(row.checkOut)}
              </span>
              <RowActionsMenu
                label="Blocked dates"
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
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input type="date" aria-label="Start date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
        <Input type="date" aria-label="End date" value={checkOut} min={checkIn || undefined} onChange={(e) => setCheckOut(e.target.value)} />
      </div>
    </div>
  );
}
