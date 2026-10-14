import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { managerCanWriteCalendarForProperty } from "@/lib/auth/manager-lease-scope";
import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
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

function tombstoneKeyOf(t: ChannelStayTombstone): string {
  return channelStayTombstoneKey({
    ...t,
    start: t.range.start,
    end: t.range.end,
    hostBlock: t.range.hostBlock,
    summary: t.range.summary,
  });
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
      ...(typeof range.hostBlock === "boolean" ? { hostBlock: range.hostBlock } : {}),
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
    if (tombstone) {
      keys.add(
        channelStayTombstoneKey({
          ...tombstone,
          start: tombstone.range.start,
          end: tombstone.range.end,
          hostBlock: tombstone.range.hostBlock,
          summary: tombstone.range.summary,
        }),
      );
    }
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
  // Ownership comes from the session + the connection's own house, never from a body id. Removing
  // or restoring a stay rewrites what the house publishes and blocks, so it needs Calendar at EDIT —
  // the same level as linking, unlinking and syncing, not the read grant.
  if (!(await managerCanWriteCalendarForProperty(db, userId, connection.property_id))) {
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
  input: { connectionId: string; sourceUid: string; start?: string; end?: string },
  persistRanges: (connection: ChannelCalendarConnectionRow, ranges: ChannelCalendarImportedRange[]) => Promise<void>,
): Promise<RemoveChannelStayResult> {
  const sourceUid = input.sourceUid.trim();
  if (!input.connectionId.trim() || !sourceUid) return { ok: false, status: 400, error: "connectionId and sourceUid are required." };
  const loaded = await loadAuthorizedConnection(db, userId, input.connectionId.trim());
  if (!loaded.ok) return loaded;
  const { connection } = loaded;
  const wantStart = input.start?.trim() ?? "";
  const sameStay = (candidate: ChannelCalendarImportedRange) =>
    importedRangeUid(candidate) === sourceUid &&
    // A host block shares its UID with every other block; the dates say which one.
    (!wantStart || !isHostBlockRange(candidate) || candidate.start === wantStart);
  const range = connection.imported_ranges.find(sameStay);
  if (!range) return { ok: false, status: 404, error: "That stay is no longer on the channel calendar." };

  const tombstone: ChannelStayTombstone = {
    propertyId: connection.property_id,
    roomId: connection.room_id,
    provider: connection.provider,
    sourceUid,
    range: { ...range, sourceUid },
    removedAt: new Date().toISOString(),
  };
  const key = tombstoneKeyOf(tombstone);
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
    connection.imported_ranges.filter((candidate) => candidate !== range),
  );
  return { ok: true, tombstone };
}

/** Undo: delete the tombstone and put the carried range back (a later sync re-confirms it). */
export async function restoreChannelStay(
  db: SupabaseClient,
  userId: string,
  input: { connectionId: string; sourceUid: string; start?: string; end?: string },
  persistRanges: (connection: ChannelCalendarConnectionRow, ranges: ChannelCalendarImportedRange[]) => Promise<void>,
): Promise<RemoveChannelStayResult> {
  const sourceUid = input.sourceUid.trim();
  if (!input.connectionId.trim() || !sourceUid) return { ok: false, status: 400, error: "connectionId and sourceUid are required." };
  const loaded = await loadAuthorizedConnection(db, userId, input.connectionId.trim());
  if (!loaded.ok) return loaded;
  const { connection } = loaded;
  const base = { propertyId: connection.property_id, roomId: connection.room_id, provider: connection.provider, sourceUid };
  const start = input.start?.trim();
  // A host block's tombstone is keyed on its dates; a reservation's on its UID alone.
  const keys = [
    ...(start ? [channelStayTombstoneKey({ ...base, start, end: input.end?.trim(), hostBlock: true })] : []),
    channelStayTombstoneKey({ ...base, hostBlock: false }),
  ];
  let recordId = "";
  let tombstone: ChannelStayTombstone | null = null;
  for (const key of keys) {
    recordId = channelStayTombstoneRecordId(key);
    const { data } = await db.from("portal_schedule_records").select("row_data").eq("id", recordId).maybeSingle();
    tombstone = parseTombstoneRow((data as { row_data?: unknown } | null)?.row_data);
    if (tombstone) break;
  }
  if (!tombstone) return { ok: false, status: 404, error: "That stay was not removed." };
  const { error } = await db.from("portal_schedule_records").delete().eq("id", recordId);
  if (error) return { ok: false, status: 400, error: "Could not restore that stay." };
  const present = connection.imported_ranges.some(
    (candidate) =>
      importedRangeUid(candidate) === sourceUid &&
      (!isHostBlockRange(tombstone.range) || candidate.start === tombstone.range.start),
  );
  if (!present && tombstone.range.start) {
    await persistRanges(connection, [...connection.imported_ranges, tombstone.range]);
  }
  return { ok: true, tombstone };
}

/**
 * A new feed has new identities: when a connection's import URL changes, every tombstone for
 * that (house, room, channel) goes. Returns how many were cleared.
 */
export async function clearChannelStayTombstonesForRoom(
  db: SupabaseClient,
  input: { propertyId: string; roomId: string; provider: string },
): Promise<number> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("record_type", CHANNEL_STAY_TOMBSTONE_RECORD_TYPE)
    .eq("property_id", input.propertyId);
  if (error) throw new Error("Could not check removed stays.");
  const ids: string[] = [];
  for (const row of (data ?? []) as Array<{ id: string; row_data?: unknown }>) {
    const t = parseTombstoneRow(row.row_data);
    if (t && t.roomId === input.roomId.trim() && t.provider === input.provider) ids.push(row.id);
  }
  if (ids.length === 0) return 0;
  const { error: delError } = await db.from("portal_schedule_records").delete().in("id", ids);
  if (delError) throw new Error("Could not clear removed stays.");
  console.info(`[channel-calendar] import_url changed: cleared ${ids.length} stay tombstone(s) for ${input.propertyId}/${input.roomId}/${input.provider}`);
  return ids.length;
}
