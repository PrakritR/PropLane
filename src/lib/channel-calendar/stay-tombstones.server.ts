import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import {
  channelStayTombstoneKey,
  importedRangeUid,
  type ChannelStayTombstone,
} from "@/lib/channel-calendar/stay-tombstones";
import type { ChannelCalendarConnectionRow, ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";
import { CHANNEL_STAY_TOMBSTONE_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";

/** Record id is a hash of the identity so a retried Remove is the same row, never a second one. */
export function channelStayTombstoneRecordId(key: string): string {
  // sha256, not sha1: the key carries the guest-facing source uid, and sha1 is a
  // broken digest (CodeQL js/weak-cryptographic-algorithm).
  return `axis_channel_tombstone_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

function parseTombstoneRow(rowData: unknown): ChannelStayTombstone | null {
  if (!rowData || typeof rowData !== "object") return null;
  const o = rowData as Record<string, unknown>;
  const propertyId = String(o.propertyId ?? "").trim();
  const sourceUid = String(o.sourceUid ?? "").trim();
  const provider = o.provider === "booking_com" || o.provider === "vrbo" ? o.provider : "airbnb";
  if (!propertyId || !sourceUid) return null;
  const range = (o.range ?? {}) as Record<string, unknown>;
  return {
    propertyId,
    roomId: String(o.roomId ?? "").trim(),
    provider,
    sourceUid,
    range: {
      id: String(range.id ?? "").trim() || sourceUid,
      sourceUid,
      start: String(range.start ?? "").trim(),
      end: String(range.end ?? range.start ?? "").trim(),
      summary: String(range.summary ?? "").trim(),
    },
    removedAt: String(o.removedAt ?? ""),
  };
}

/** Every tombstone for these houses, as keys (what a sync prunes against). */
export async function loadChannelStayTombstoneKeys(
  db: SupabaseClient,
  propertyIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return new Set();
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data")
    .eq("record_type", CHANNEL_STAY_TOMBSTONE_RECORD_TYPE)
    .in("property_id", ids);
  // A read failure must not let a sync resurrect removed stays silently.
  if (error) throw new Error("Could not check removed stays.");
  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<{ row_data?: unknown }>) {
    const tombstone = parseTombstoneRow(row.row_data);
    if (tombstone) keys.add(channelStayTombstoneKey(tombstone));
  }
  return keys;
}

export type RemoveChannelStayResult =
  | { ok: true; tombstone: ChannelStayTombstone }
  | { ok: false; status: 400 | 403 | 404; error: string };

async function loadAuthorizedConnection(
  db: SupabaseClient,
  userId: string,
  connectionId: string,
): Promise<{ ok: true; connection: ChannelCalendarConnectionRow } | { ok: false; status: 403 | 404; error: string }> {
  const { data } = await db.from("external_calendar_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!data) return { ok: false, status: 404, error: "Connection not found." };
  const connection = parseConnectionRow(data as Record<string, unknown>);
  // Ownership comes from the session + the connection's own house, never from a body id.
  if (!(await managerHasCalendarAccessForProperty(db, userId, connection.property_id))) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  return { ok: true, connection };
}

/**
 * Remove stay: write the tombstone, then pull the reservation out of what the
 * connection stores. The range is kept inside the tombstone for Undo.
 */
export async function removeChannelStay(
  db: SupabaseClient,
  userId: string,
  input: { connectionId: string; sourceUid: string },
  persistRanges: (connection: ChannelCalendarConnectionRow, ranges: ChannelCalendarImportedRange[]) => Promise<void>,
): Promise<RemoveChannelStayResult> {
  const sourceUid = input.sourceUid.trim();
  if (!input.connectionId.trim() || !sourceUid) return { ok: false, status: 400, error: "connectionId and sourceUid are required." };
  const loaded = await loadAuthorizedConnection(db, userId, input.connectionId.trim());
  if (!loaded.ok) return loaded;
  const { connection } = loaded;
  const range = connection.imported_ranges.find((candidate) => importedRangeUid(candidate) === sourceUid);
  if (!range) return { ok: false, status: 404, error: "That stay is no longer on the channel calendar." };

  const tombstone: ChannelStayTombstone = {
    propertyId: connection.property_id,
    roomId: connection.room_id,
    provider: connection.provider,
    sourceUid,
    range: { ...range, sourceUid },
    removedAt: new Date().toISOString(),
  };
  const key = channelStayTombstoneKey(tombstone);
  const { error } = await db.from("portal_schedule_records").upsert(
    {
      id: channelStayTombstoneRecordId(key),
      manager_user_id: connection.manager_user_id,
      property_id: connection.property_id,
      record_type: CHANNEL_STAY_TOMBSTONE_RECORD_TYPE,
      starts_at: null,
      ends_at: null,
      row_data: { ...tombstone, recordType: CHANNEL_STAY_TOMBSTONE_RECORD_TYPE, removedBy: userId },
      updated_at: tombstone.removedAt,
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, status: 400, error: "Could not remove that stay." };
  await persistRanges(
    connection,
    connection.imported_ranges.filter((candidate) => importedRangeUid(candidate) !== sourceUid),
  );
  return { ok: true, tombstone };
}

/** Undo: delete the tombstone and put the carried range back (a later sync re-confirms it). */
export async function restoreChannelStay(
  db: SupabaseClient,
  userId: string,
  input: { connectionId: string; sourceUid: string },
  persistRanges: (connection: ChannelCalendarConnectionRow, ranges: ChannelCalendarImportedRange[]) => Promise<void>,
): Promise<RemoveChannelStayResult> {
  const sourceUid = input.sourceUid.trim();
  if (!input.connectionId.trim() || !sourceUid) return { ok: false, status: 400, error: "connectionId and sourceUid are required." };
  const loaded = await loadAuthorizedConnection(db, userId, input.connectionId.trim());
  if (!loaded.ok) return loaded;
  const { connection } = loaded;
  const key = channelStayTombstoneKey({
    propertyId: connection.property_id,
    roomId: connection.room_id,
    provider: connection.provider,
    sourceUid,
  });
  const recordId = channelStayTombstoneRecordId(key);
  const { data } = await db.from("portal_schedule_records").select("row_data").eq("id", recordId).maybeSingle();
  const tombstone = parseTombstoneRow((data as { row_data?: unknown } | null)?.row_data);
  if (!tombstone) return { ok: false, status: 404, error: "That stay was not removed." };
  const { error } = await db.from("portal_schedule_records").delete().eq("id", recordId);
  if (error) return { ok: false, status: 400, error: "Could not restore that stay." };
  const present = connection.imported_ranges.some((candidate) => importedRangeUid(candidate) === sourceUid);
  if (!present && tombstone.range.start) {
    await persistRanges(connection, [...connection.imported_ranges, tombstone.range]);
  }
  return { ok: true, tombstone };
}
