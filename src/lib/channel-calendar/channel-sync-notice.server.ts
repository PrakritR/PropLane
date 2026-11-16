import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { emitActionEvent } from "@/lib/action-events.server";
import { channelCalendarProviderLabel } from "@/lib/channel-calendar/airbnb-url";
import { EXPORT_FEED_ERROR_PREFIX, SYNC_NOTICE_AFTER_MS } from "@/lib/channel-calendar/channel-health";
import { loadPropertyRecord } from "@/lib/channel-calendar/sync.server";
import type { ChannelCalendarProvider } from "@/lib/channel-calendar/types";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { formatSyncFailureNotice } from "@/lib/manager-notice-format";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";

type SyncRow = {
  id: unknown;
  manager_user_id: unknown;
  property_id: unknown;
  room_id: unknown;
  provider: unknown;
  label: unknown;
  last_synced_at: unknown;
  last_error: unknown;
  created_at: unknown;
};

/** The event id is the connection + the Pacific day: one notice per failing connection per day, however often the cron runs. */
export function channelSyncFailedEventId(connectionId: string, day: string): string {
  return `channel_sync_failed:${connectionId}:${day}`;
}

/**
 * Tell a manager when a linked channel calendar has not synced for {@link SYNC_NOTICE_AFTER_MS}: the one existing
 * notice path (`emitActionEvent`, the manager's Assistant notice), rich text from `formatSyncFailureNotice`.
 * One cheap read per run (only connections already past the threshold), best-effort per connection: a notice that
 * cannot be sent never fails the cron. Returns how many were announced (a repeat on the same day is a duplicate).
 */
export async function notifyFailingChannelSyncs(db: SupabaseClient, now: Date = new Date()): Promise<{ checked: number; notified: number }> {
  const cutoff = new Date(now.getTime() - SYNC_NOTICE_AFTER_MS).toISOString();
  const { data, error } = await db
    .from("external_calendar_connections")
    .select("id, manager_user_id, property_id, room_id, provider, label, last_synced_at, last_error, created_at")
    .not("import_url", "is", null)
    .or(`last_synced_at.lt.${cutoff},and(last_synced_at.is.null,created_at.lt.${cutoff})`);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as SyncRow[]).filter((row) => String(row.manager_user_id ?? "").trim());
  const day = pacificCalendarDateYmd(now);
  const profiles = new Map<string, { email: string; name: string }>();
  const houses = new Map<string, Awaited<ReturnType<typeof loadPropertyRecord>>>();
  let notified = 0;
  for (const row of rows) {
    try {
      const connectionId = String(row.id);
      const managerUserId = String(row.manager_user_id);
      const propertyId = String(row.property_id ?? "");
      if (!profiles.has(managerUserId)) {
        const { data: manager } = await db.from("profiles").select("email, full_name").eq("id", managerUserId).maybeSingle();
        profiles.set(managerUserId, { email: String(manager?.email ?? "").trim().toLowerCase(), name: String(manager?.full_name ?? "").trim() });
      }
      const manager = profiles.get(managerUserId)!;
      if (!manager.email) continue;
      if (!houses.has(propertyId)) houses.set(propertyId, await loadPropertyRecord(db, propertyId));
      const record = houses.get(propertyId);
      const property = record?.property;
      const roomId = String(row.room_id ?? "");
      const roomName = property?.listingSubmission?.rooms?.find((room) => room.id === roomId)?.name?.trim() || String(row.label ?? "").trim();
      const provider = String(row.provider ?? "airbnb") as ChannelCalendarProvider;
      const channel = channelCalendarProviderLabel(provider, typeof row.label === "string" ? row.label : null);
      const lastSynced = Date.parse(String(row.last_synced_at ?? ""));
      const lastError = String(row.last_error ?? "");
      const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/settings?tab=spreadsheets&integration=bookings`;
      const notice = formatSyncFailureNotice({
        channel,
        house: property?.buildingName?.trim() || property?.title?.trim() || "",
        room: roomName,
        hoursSince: Number.isFinite(lastSynced) ? (now.getTime() - lastSynced) / 3_600_000 : 0,
        error: lastError && !lastError.startsWith(EXPORT_FEED_ERROR_PREFIX) ? lastError : null,
        url,
      });
      const eventId = channelSyncFailedEventId(connectionId, day);
      const result = await emitActionEvent(db, {
        eventId,
        domain: "channel_booking",
        event: "channel_sync_failed",
        managerUserId,
        entityId: connectionId,
        category: "tours",
        senderUserId: managerUserId,
        senderEmail: manager.email,
        senderName: manager.name || undefined,
        payload: { propertyId, roomId, connectionId, provider, channelLabel: channel, roomLabel: roomName, url },
        templateContext: { propertyTitle: property?.buildingName ?? property?.title ?? "", roomLabel: roomName, url },
        recipients: [{ audience: "manager", userId: managerUserId, rendered: { subject: notice.subject, text: notice.sms, smsText: notice.sms } }],
      });
      if (!result.duplicate) notified += 1;
    } catch (e) {
      console.warn("[channel-calendar] sync failure notice failed", { connectionId: String(row.id), message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { checked: rows.length, notified };
}
