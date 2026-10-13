import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { managerCanWriteCalendarForProperty, managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import { parseConnectionRow } from "@/lib/channel-calendar/connections.server";
import {
  normalizeStayCents,
  normalizeStayGuestName,
  normalizeStayNotes,
  normalizeStayPaidAt,
  normalizeStayPhone,
  type ChannelStayDetails,
  type ChannelStayMoney,
} from "@/lib/channel-calendar/stay-details";
import { importedRangeUid } from "@/lib/channel-calendar/stay-tombstones";

export type StayDetailsResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 500; error: string };

/** The connection's own house decides access; a house id in a request body is never read. */
async function loadConnection(db: SupabaseClient, connectionId: string) {
  const { data } = await db.from("external_calendar_connections").select("*").eq("id", connectionId).maybeSingle();
  return data ? parseConnectionRow(data as Record<string, unknown>) : null;
}

const STAY_COLUMNS = "guest_name, notes, guest_phone, nightly_cents, payout_cents, paid_at, currency, source";

type StayRow = {
  guest_name?: string | null;
  notes?: string | null;
  guest_phone?: string | null;
  nightly_cents?: number | null;
  payout_cents?: number | null;
  paid_at?: string | null;
  currency?: string | null;
  source?: string | null;
};

/** Only the money fields that are actually set, so an unset stay serialises exactly as before. */
export function moneyFromRow(row: StayRow | null | undefined): ChannelStayMoney {
  if (!row) return {};
  return {
    ...(row.guest_phone ? { guestPhone: row.guest_phone } : {}),
    ...(typeof row.nightly_cents === "number" ? { nightlyCents: row.nightly_cents } : {}),
    ...(typeof row.payout_cents === "number" ? { payoutCents: row.payout_cents } : {}),
    ...(row.paid_at ? { paidAt: row.paid_at } : {}),
    ...(row.currency && typeof row.payout_cents === "number" ? { currency: row.currency } : {}),
    ...(row.source && row.source !== "manual" ? { source: row.source } : {}),
  };
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
    .select(STAY_COLUMNS)
    .eq("connection_id", connection.id)
    .eq("source_uid", sourceUid)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Could not load stay details." };
  const row = data as StayRow | null;
  return { ok: true, value: { guestName: row?.guest_name ?? "", notes: row?.notes ?? "", ...moneyFromRow(row) } };
}

/**
 * Save the manager-entered details for one channel stay. Every field is patched only when its key
 * is present: undefined leaves the stored value alone, blank clears it. A stay left with no name,
 * no note and no money at all is deleted.
 */
export async function saveChannelStayDetails(
  db: SupabaseClient,
  userId: string,
  input: {
    connectionId: string;
    sourceUid: string;
    guestName?: unknown;
    notes?: unknown;
    guestPhone?: unknown;
    nightlyCents?: unknown;
    payoutCents?: unknown;
    paidAt?: unknown;
  },
): Promise<StayDetailsResult<ChannelStayDetails & ChannelStayMoney>> {
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
  const patch: Record<string, unknown> = {};
  if (input.guestPhone !== undefined) patch.guest_phone = normalizeStayPhone(input.guestPhone) || null;
  if (input.nightlyCents !== undefined) {
    const cents = normalizeStayCents(input.nightlyCents);
    if (input.nightlyCents !== null && input.nightlyCents !== "" && cents === null) return { ok: false, status: 400, error: "Nightly rate is not a valid amount." };
    patch.nightly_cents = cents;
  }
  if (input.payoutCents !== undefined) {
    const cents = normalizeStayCents(input.payoutCents);
    if (input.payoutCents !== null && input.payoutCents !== "" && cents === null) return { ok: false, status: 400, error: "Payout is not a valid amount." };
    patch.payout_cents = cents;
    if (cents !== null) patch.currency = "USD";
  }
  if (input.paidAt !== undefined) {
    const paidAt = normalizeStayPaidAt(input.paidAt);
    if (input.paidAt && !paidAt) return { ok: false, status: 400, error: "Paid on is not a valid date." };
    patch.paid_at = paidAt;
  }

  const { data: storedData, error: storedError } = await db
    .from("channel_stay_details")
    .select(STAY_COLUMNS)
    .eq("connection_id", connection.id)
    .eq("source_uid", sourceUid)
    .maybeSingle();
  if (storedError) return { ok: false, status: 500, error: "Could not save stay details." };
  const stored = storedData as StayRow | null;
  // An absent key is "leave it alone" for every field, whatever else the save carried:
  // a money-only save (Mark paid) and a note-only save both keep the name they never showed.
  const guestName = input.guestName === undefined ? normalizeStayGuestName(stored?.guest_name) : normalizeStayGuestName(input.guestName);
  const notes = input.notes === undefined ? normalizeStayNotes(stored?.notes) : normalizeStayNotes(input.notes);
  const merged: StayRow = { ...(stored ?? {}), ...patch } as StayRow;
  const moneyAfter = moneyFromRow(merged);
  const hasMoney = Object.keys(moneyAfter).some((key) => key !== "currency");
  if (!guestName && !notes && !hasMoney) {
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
      ...patch,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "connection_id,source_uid" },
  );
  if (error) return { ok: false, status: 500, error: "Could not save stay details." };
  return { ok: true, value: { guestName, notes, ...moneyAfter } };
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

export type ChannelStayDetailRow = { guestName: string } & ChannelStayMoney;

/** Name + money for many connections in ONE query: connectionId -> sourceUid -> details. Failure reads as "nothing typed". */
export async function loadChannelStayDetailRows(
  db: SupabaseClient,
  connectionIds: readonly string[],
): Promise<Map<string, Map<string, ChannelStayDetailRow>>> {
  const ids = [...new Set(connectionIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, Map<string, ChannelStayDetailRow>>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("channel_stay_details")
    .select(`connection_id, source_uid, ${STAY_COLUMNS}`)
    .in("connection_id", ids);
  if (error) return out;
  for (const row of (data ?? []) as Array<StayRow & { connection_id?: string; source_uid?: string }>) {
    if (!row.connection_id || !row.source_uid) continue;
    const byUid = out.get(row.connection_id) ?? new Map<string, ChannelStayDetailRow>();
    byUid.set(row.source_uid, { guestName: row.guest_name?.trim() ?? "", ...moneyFromRow(row) });
    out.set(row.connection_id, byUid);
  }
  return out;
}
