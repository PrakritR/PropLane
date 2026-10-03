"use client";

import { useCallback, useEffect, useState } from "react";
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

type BlockRow = {
  /** Stable React key; equals the saved block's id once it exists. */
  key: string;
  /** The saved block's id; absent until both dates are set and saved. */
  id?: string;
  checkIn: string;
  checkOut: string;
  reason: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Blocked dates (captain, Oct 3): every span is its own row of two dates you can
 * always edit, with a ⋯ that deletes it. The round + only adds an empty row; a
 * row saves itself as soon as both dates are set (end on or after start).
 */
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
  const [rows, setRows] = useState<BlockRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!propertyId) {
      setRows([]);
      return;
    }
    setLoading(true);
    fetchRoomDateBlocks()
      .then((all) => {
        const saved = managerBlocksForRoom(all, propertyId, roomId)
          .sort((a, b) => a.checkIn.localeCompare(b.checkIn))
          .map<BlockRow>((b) => ({
            key: b.id,
            id: b.id,
            checkIn: b.checkIn,
            checkOut: b.openEnded ? "" : b.checkOut,
            reason: b.reason || "Blocked by manager",
          }));
        // Keep any row still being typed (no id yet) below the saved ones.
        setRows((prev) => [...saved, ...prev.filter((r) => !r.id)]);
      })
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

  const addRow = () => {
    setRows((prev) => [...prev, { key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, checkIn: "", checkOut: "", reason: "Blocked by manager" }]);
  };

  const saveRow = async (row: BlockRow) => {
    if (!propertyId || !managerUserId) {
      showToast?.("Save the property before blocking dates.");
      return;
    }
    if (!ISO_DATE.test(row.checkIn) || !ISO_DATE.test(row.checkOut)) return;
    if (row.checkOut < row.checkIn) {
      showToast?.("The end date is before the start date.");
      return;
    }
    setSavingKey(row.key);
    try {
      const saved = await saveRoomDateBlock(managerUserId, {
        id: row.id,
        propertyId,
        roomId,
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        openEnded: false,
        reason: row.reason,
        bookingStatus: "hold",
      });
      setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, id: saved.id } : r)));
    } catch (e) {
      showToast?.(e instanceof Error ? e.message : "Could not block those dates.");
    } finally {
      setSavingKey(null);
    }
  };

  const changeRow = (key: string, patch: Partial<Pick<BlockRow, "checkIn" | "checkOut">>) => {
    const current = rows.find((r) => r.key === key);
    if (!current) return;
    const next = { ...current, ...patch };
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    void saveRow(next);
  };

  const removeRow = (row: BlockRow) => {
    if (!row.id) {
      setRows((prev) => prev.filter((r) => r.key !== row.key));
      return;
    }
    void deleteRoomDateBlock(row.id)
      .then(() => setRows((prev) => prev.filter((r) => r.key !== row.key)))
      .catch(() => showToast?.("Could not remove that block."));
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
        <PortalPrimaryIconAction label="Add blocked dates" onClick={addRow} data-attr="room-blocked-dates-add" />
      </div>
      {loading && rows.length === 0 ? <p className="text-xs text-muted">Loading…</p> : null}
      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li
              key={row.key}
              className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-2"
              data-attr="room-blocked-dates-row"
              aria-busy={savingKey === row.key || undefined}
            >
              <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                <Input
                  type="date"
                  aria-label={`Start date, blocked span ${index + 1}`}
                  value={row.checkIn}
                  max={row.checkOut || undefined}
                  onChange={(e) => changeRow(row.key, { checkIn: e.target.value })}
                />
                <Input
                  type="date"
                  aria-label={`End date, blocked span ${index + 1}`}
                  value={row.checkOut}
                  min={row.checkIn || undefined}
                  onChange={(e) => changeRow(row.key, { checkOut: e.target.value })}
                />
              </div>
              <RowActionsMenu
                label={`Blocked span ${index + 1}`}
                items={[{ id: "delete", label: "Delete", danger: true, onSelect: () => removeRow(row) }]}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
