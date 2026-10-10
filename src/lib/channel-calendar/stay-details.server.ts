import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { managerCanWriteCalendarForProperty, managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import { normalizeStayGuestName, normalizeStayNotes, type ChannelStayDetails } from "@/lib/channel-calendar/stay-details";
import { importedRangeUid } from "@/lib/channel-calendar/stay-tombstones";

export type StayDetailsResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 500; error: string };

/** The connection's own house decides access; a house id in a request body is never read. */
async function loadConnection(db: SupabaseClient, connectionId: string) {
  const { data } = await db.from("external_calendar_connections").select("*").eq("id", connectionId).maybeSingle();
  return data ? parseConnectionRow(data as Record<string, unknown>) : null;
}

export async function readChannelStayDetails(
  db: SupabaseClient,
  userId: string,
  input: { connectionId: string; sourceUid: string },
): Promise<StayDetailsResult<ChannelStayDetails>> {
  const connectionId = input.connectionId.trim();
  const sourceUid = input.sourceUid.trim();
  if (!connectionId || !sourceUid) return { ok: false, status: 400, error: "connectionId and sourceUid are required." };
  const connection = await loadConnection(db, connectionId);
  if (!connection) return { ok: false, status: 404, error: "Connection not found." };
  if (!(await managerHasCalendarAccessForProperty(db, userId, connection.property_id))) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const { data, error } = await db
    .from("channel_stay_details")
    .select("guest_name, notes")
    .eq("connection_id", connection.id)
    .eq("source_uid", sourceUid)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Could not load stay details." };
  const row = data as { guest_name?: string | null; notes?: string | null } | null;
  return { ok: true, value: { guestName: row?.guest_name ?? "", notes: row?.notes ?? "" } };
}

/** Save (or clear, when both fields are empty) the manager-entered details for one channel stay. */
export async function saveChannelStayDetails(
  db: SupabaseClient,
  userId: string,
  input: { connectionId: string; sourceUid: string; guestName: unknown; notes?: unknown },
): Promise<StayDetailsResult<ChannelStayDetails>> {
  const connectionId = input.connectionId.trim();
  const sourceUid = input.sourceUid.trim();
  if (!connectionId || !sourceUid) return { ok: false, status: 400, error: "connectionId and sourceUid are required." };
  const connection = await loadConnection(db, connectionId);
  if (!connection) return { ok: false, status: 404, error: "Connection not found." };
  // Writing a name changes what the whole team sees on the booking, so it needs Calendar at EDIT.
  if (!(await managerCanWriteCalendarForProperty(db, userId, connection.property_id))) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  // Only a stay this connection actually carries can be named.
  if (!connection.imported_ranges.some((range) => importedRangeUid(range) === sourceUid)) {
    return { ok: false, status: 404, error: "That stay is no longer on the channel calendar." };
  }
  const guestName = normalizeStayGuestName(input.guestName);
  const notes = normalizeStayNotes(input.notes);
  if (!guestName && !notes) {
    const { error } = await db.from("channel_stay_details").delete().eq("connection_id", connection.id).eq("source_uid", sourceUid);
    if (error) return { ok: false, status: 500, error: "Could not save stay details." };
    return { ok: true, value: { guestName: "", notes: "" } };
  }
  const { error } = await db.from("channel_stay_details").upsert(
    {
      connection_id: connection.id,
      source_uid: sourceUid,
      guest_name: guestName || null,
      notes: notes || null,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "connection_id,source_uid" },
  );
  if (error) return { ok: false, status: 500, error: "Could not save stay details." };
  return { ok: true, value: { guestName, notes } };
}

/** Guest names for many connections in ONE query: connectionId -> sourceUid -> name. */
export async function loadChannelStayGuestNames(
  db: SupabaseClient,
  connectionIds: readonly string[],
): Promise<Map<string, Map<string, string>>> {
  const ids = [...new Set(connectionIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, Map<string, string>>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("channel_stay_details")
    .select("connection_id, source_uid, guest_name")
    .in("connection_id", ids);
  // A missing name is cosmetic: the booking still draws with its Airbnb label.
  if (error) return out;
  for (const row of (data ?? []) as Array<{ connection_id?: string; source_uid?: string; guest_name?: string | null }>) {
    const name = row.guest_name?.trim();
    if (!row.connection_id || !row.source_uid || !name) continue;
    const byUid = out.get(row.connection_id) ?? new Map<string, string>();
    byUid.set(row.source_uid, name);
    out.set(row.connection_id, byUid);
  }
  return out;
}
