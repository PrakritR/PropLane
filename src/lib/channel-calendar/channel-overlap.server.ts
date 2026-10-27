import "server-only";

/**
 * The server's half of "no double bookings": a PropLane stay is refused when it lands on nights a channel
 * already holds in that room (or the whole home). The schedule-records route asks it for every manager
 * save, and the assistant's block tools ask it for theirs, so the answer is the same from every door.
 * The rules live in `channel-overlap.ts`; this reads the rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { listingSubmissionFromProperty, parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { findChannelClashes, findChannelOverlap, linkedRangeForStay, type ChannelClash, type ChannelOverlapRange, type OverlapNativeStay } from "@/lib/channel-calendar/channel-overlap";
import { normalizeChannelLink, linkTargetsRange, type ChannelLink } from "@/lib/channel-calendar/channel-link";
import { pruneTombstonedRanges } from "@/lib/channel-calendar/stay-tombstones";
import { loadChannelStayTombstoneKeys } from "@/lib/channel-calendar/stay-tombstones.server";
import { loadChannelStayGuestNames } from "@/lib/channel-calendar/stay-details.server";

export const CHANNEL_OVERLAP_UNVERIFIED = "Could not verify room availability. Try again.";

/** The property's listing data, for room names. (Not `sync.server`'s loader: that module calls this one.) */
async function loadProperty(db: SupabaseClient, propertyId: string) {
  const { data } = await db.from("manager_property_records").select("property_data").eq("id", propertyId).maybeSingle();
  return { property: (data?.property_data ?? null) as Parameters<typeof listingSubmissionFromProperty>[0] };
}

function roomLabelOf(property: Parameters<typeof listingSubmissionFromProperty>[0], roomId: string, fallback: string | null): string {
  const room = listingSubmissionFromProperty(property)?.rooms.find((candidate) => candidate.id === roomId);
  return room?.name?.trim() || fallback?.trim() || roomId;
}

/** Every imported range of a house's channel connections, tombstoned stays dropped. Throws when a read fails. */
export async function loadChannelOverlapRanges(db: SupabaseClient, propertyId: string): Promise<ChannelOverlapRange[]> {
  // Only the columns the ranges below are built from: this read repeats for every connection of the house on
  // every sync (each one must see what the ones before it just imported), so `*` dragged each row's export
  // token, import url and released-identity history along with it on a free-plan egress budget.
  const { data, error } = await db
    .from("external_calendar_connections")
    .select("id, manager_user_id, property_id, room_id, provider, label, imported_ranges, last_synced_at")
    .eq("property_id", propertyId);
  if (error) throw new Error(error.message);
  const connections = (data ?? []).map((row) => parseConnectionRow(row as Record<string, unknown>));
  if (connections.every((connection) => (connection.imported_ranges ?? []).length === 0)) return [];
  const [tombstones, names, record] = await Promise.all([
    loadChannelStayTombstoneKeys(db, [propertyId]),
    loadChannelStayGuestNames(db, connections.map((connection) => connection.id)),
    loadProperty(db, propertyId),
  ]);
  const out: ChannelOverlapRange[] = [];
  for (const connection of connections) {
    const kept = pruneTombstonedRanges(
      connection.imported_ranges ?? [],
      { propertyId, roomId: connection.room_id, provider: connection.provider },
      tombstones,
    ).kept;
    const wholeHome = connection.room_id === propertyId;
    const roomLabel = wholeHome ? "The whole home" : roomLabelOf(record?.property ?? null, connection.room_id, connection.label);
    for (const range of kept) {
      out.push({
        provider: connection.provider,
        connectionId: connection.id,
        label: connection.label,
        propertyId,
        roomId: connection.room_id,
        sourceUid: range.sourceUid || range.id,
        ...(range.reservationCode ? { reservationCode: range.reservationCode } : {}),
        summary: range.summary,
        ...(range.hostBlock ? { hostBlock: true } : {}),
        start: range.start,
        end: range.end || range.start,
        ...(names.get(connection.id)?.get(range.sourceUid || range.id) ? { guestName: names.get(connection.id)!.get(range.sourceUid || range.id)! } : {}),
        roomLabel,
      });
    }
  }
  return out;
}

type BlockRow = { id?: unknown; row_data?: unknown };

function dataOf(row: BlockRow): Record<string, unknown> {
  const data = row.row_data;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The house's `room_date_block` rows as the echo subtraction and the auto-link need them. */
export function overlapContextFromBlockRows(rows: readonly BlockRow[], ownId: string): { natives: Array<OverlapNativeStay & { id: string }>; otherLinks: ChannelLink[] } {
  const natives: Array<OverlapNativeStay & { id: string }> = [];
  const otherLinks: ChannelLink[] = [];
  for (const row of rows) {
    const data = dataOf(row);
    const checkIn = text(data.checkIn);
    const checkOut = text(data.checkOut);
    if (!checkIn || !checkOut) continue;
    const stayDetails = data.stayDetails && typeof data.stayDetails === "object" ? (data.stayDetails as Record<string, unknown>) : {};
    const link = normalizeChannelLink(stayDetails.channelLink);
    const cancelled = data.bookingStatus === "cancelled";
    natives.push({
      id: String(row.id ?? ""),
      name: text(data.residentName),
      reason: text(data.reason),
      roomId: text(data.roomId),
      checkIn,
      checkOut,
      openEnded: data.openEnded === true,
      cancelled,
      ...(link ? { link } : {}),
      ...(data.blockKind === "closed" ? { blockKind: "closed" } : {}),
    });
    if (link && !cancelled && String(row.id ?? "") !== ownId) otherLinks.push(link);
  }
  return { natives, otherLinks };
}

export type StayChannelCheck = {
  /** The refusal to send back, or null when the stay may be saved. */
  conflict: string | null;
  /** The link to store on the stay (undefined = store none). */
  link: ChannelLink | undefined;
};

/**
 * Checks one stay against what the house's channels hold.
 * `link` is what the save carries; `storedLink` what the row already has. A link no reservation of the
 * house answers to is dropped unless it was already stored (a reservation can leave the feed). A stay
 * with no link is auto-linked when `derive` is set (HM code in its notes, or the same room and dates),
 * and that link is stored with this save: the next manager save, never a background write.
 */
export async function checkStayAgainstChannels(
  db: SupabaseClient,
  input: {
    propertyId: string;
    roomId: string;
    checkIn: string;
    checkOut: string;
    openEnded?: boolean;
    reason?: string | null;
    link?: ChannelLink;
    storedLink?: ChannelLink;
    derive: boolean;
    ownId: string;
    blockRows: readonly BlockRow[];
  },
): Promise<StayChannelCheck> {
  let ranges: ChannelOverlapRange[];
  try {
    ranges = await loadChannelOverlapRanges(db, input.propertyId);
  } catch {
    return { conflict: CHANNEL_OVERLAP_UNVERIFIED, link: input.link };
  }
  const { natives, otherLinks } = overlapContextFromBlockRows(input.blockRows, input.ownId);
  const resolved = linkedRangeForStay({
    propertyId: input.propertyId,
    roomId: input.roomId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    openEnded: input.openEnded,
    reason: input.reason,
    link: input.link,
    ranges,
    otherLinks,
    derive: input.derive,
  });
  let link = input.link;
  if (input.link && !resolved.verified && !(input.storedLink && linkTargetsRange(input.link, { provider: input.storedLink.provider, sourceUid: input.storedLink.sourceUid, reservationCode: input.storedLink.reservationCode }))) {
    link = undefined;
  } else if (!input.link && input.derive && resolved.derived) {
    link = resolved.link;
  }
  const hit = findChannelOverlap({
    propertyId: input.propertyId,
    roomId: input.roomId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    openEnded: input.openEnded,
    ranges,
    natives,
    // An undone link must not exempt a range; a derived or verified one does.
    linked: link ? resolved.range : undefined,
  });
  return { conflict: hit?.message ?? null, link };
}

/**
 * The double bookings a just-finished sync of `connectionId` is part of: channel against channel, or a
 * channel reservation against a PropLane stay that is not that reservation. Reads only; the caller alerts.
 * Over-and-done clashes (`today`) are not news.
 */
export async function detectChannelClashes(
  db: SupabaseClient,
  input: { propertyId: string; connectionId: string; today: string },
): Promise<ChannelClash[]> {
  const ranges = await loadChannelOverlapRanges(db, input.propertyId);
  if (ranges.length === 0) return [];
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("property_id", input.propertyId)
    .eq("record_type", "room_date_block");
  if (error) throw new Error(error.message);
  const { natives } = overlapContextFromBlockRows((data ?? []) as BlockRow[], "");
  return findChannelClashes({ propertyId: input.propertyId, ranges, natives, connectionId: input.connectionId, today: input.today });
}
