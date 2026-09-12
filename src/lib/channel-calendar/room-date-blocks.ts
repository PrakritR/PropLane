"use client";

/**
 * A manager's explicit "these dates are closed" ranges, stored as
 * `room_date_block` rows in `portal_schedule_records`. Each block is its own
 * record so removing one never rewrites the others. Check-out is exclusive,
 * matching how a stay is entered: block Sep 10 → Sep 12 and Sep 12 is free.
 */

import type { RoomDateBlock } from "@/lib/channel-calendar/property-bookings";
import { ROOM_DATE_BLOCK_RECORD_TYPE, roomDateBlockRecordId } from "@/lib/portal-schedule-record-scope";

export const ROOM_DATE_BLOCKS_CHANGED = "axis:room-date-blocks-changed";

type BlockRow = {
  id?: unknown;
  recordType?: unknown;
  propertyId?: unknown;
  roomId?: unknown;
  checkIn?: unknown;
  checkOut?: unknown;
  reason?: unknown;
  createdAt?: unknown;
};

function normalizeBlock(raw: unknown): RoomDateBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as BlockRow;
  if (row.recordType !== ROOM_DATE_BLOCK_RECORD_TYPE) return null;
  if (typeof row.id !== "string" || typeof row.propertyId !== "string") return null;
  if (typeof row.checkIn !== "string" || typeof row.checkOut !== "string") return null;
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomId: typeof row.roomId === "string" ? row.roomId : "",
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    reason: typeof row.reason === "string" ? row.reason : "",
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // not JSON
  }
  return fallback;
}

export async function fetchRoomDateBlocks(): Promise<RoomDateBlock[]> {
  const res = await fetch("/api/portal-schedule-records", { cache: "no-store", credentials: "include" });
  if (!res.ok) throw new Error(await readError(res, "Could not load blocked dates."));
  const body = (await res.json()) as { rows?: unknown[] };
  if (!Array.isArray(body.rows)) return [];
  return body.rows
    .map(normalizeBlock)
    .filter((block): block is RoomDateBlock => block !== null)
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
}

export async function saveRoomDateBlock(
  userId: string,
  input: { propertyId: string; roomId: string; checkIn: string; checkOut: string; reason: string },
): Promise<RoomDateBlock> {
  const uid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const block: RoomDateBlock = {
    id: roomDateBlockRecordId(userId, uid),
    propertyId: input.propertyId,
    roomId: input.roomId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    reason: input.reason.trim(),
    createdAt: new Date().toISOString(),
  };
  const res = await fetch("/api/portal-schedule-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      action: "upsert",
      row: {
        ...block,
        recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
        startsAt: `${block.checkIn}T00:00:00`,
        endsAt: `${block.checkOut}T00:00:00`,
      },
    }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not block those dates."));
  window.dispatchEvent(new Event(ROOM_DATE_BLOCKS_CHANGED));
  return block;
}

export async function deleteRoomDateBlock(blockId: string): Promise<void> {
  const res = await fetch("/api/portal-schedule-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action: "delete", id: blockId }),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not remove that block."));
  window.dispatchEvent(new Event(ROOM_DATE_BLOCKS_CHANGED));
}
