import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isGoogleCalendarNotLinkedError,
  listGoogleCalendarEventsForSync,
  watchGoogleCalendar,
} from "@/lib/google-calendar/api.server";
import { PROPLANE_GOOGLE_CALENDAR_MARKER } from "@/lib/google-calendar/markers";
import {
  loadGoogleCalendarConnection,
  saveGoogleCalendarConnection,
  type GoogleCalendarConnection,
} from "@/lib/google-calendar/settings";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

const GOOGLE_MEETING_RECORD_PREFIX = "axis_google_meeting_";

/** `axis_google_meeting_<managerUserId>_<googleEventId>` — stable, so the upsert is idempotent. */
export function googleMeetingRecordId(managerUserId: string, googleEventId: string): string {
  return `${GOOGLE_MEETING_RECORD_PREFIX}${managerUserId}_${googleEventId}`;
}

function isProplaneOriginatedEvent(description: string | undefined): boolean {
  return (description ?? "").toLowerCase().includes(PROPLANE_GOOGLE_CALENDAR_MARKER.toLowerCase());
}

/** Renew the watch channel once it is within this much of expiring, or missing entirely. */
const CHANNEL_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export type GoogleCalendarPullResult = {
  ok: boolean;
  upserted: number;
  deleted: number;
  skippedProplaneOriginated: number;
  reason?: string;
};

/**
 * Pull a manager's Google Calendar (incrementally, once a `syncToken` is on
 * file) and mirror every non-PropLane meeting into `portal_schedule_records`
 * as a `google_meeting` row.
 *
 * Two callers trigger this, by design (see WS3 handoff notes — Testing-mode
 * OAuth apps cannot always take live push on an unverified webhook domain):
 * the webhook route (`/api/portal/google-calendar/webhook`), when Google push
 * is live, and a lazy poll-on-read from the events route every time a manager
 * opens their calendar. Both call the SAME function so a cancelled Google
 * event is never handled two different ways depending on which one fired.
 *
 * Also opportunistically (re)creates the push-notification channel when it is
 * missing or close to expiring ("lazy renew-on-read" — see the WS3 handoff
 * notes for why a cron sweeper was not built instead).
 */
export async function pullGoogleCalendarMeetings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<GoogleCalendarPullResult> {
  const uid = managerUserId.trim();
  if (!uid) {
    return { ok: false, upserted: 0, deleted: 0, skippedProplaneOriginated: 0, reason: "missing_manager" };
  }

  const connection = await loadGoogleCalendarConnection(db, uid);
  if (!connection.connected || !connection.syncEnabled) {
    return { ok: false, upserted: 0, deleted: 0, skippedProplaneOriginated: 0, reason: "not_connected" };
  }

  let page;
  try {
    page = await listGoogleCalendarEventsForSync(db, uid, connection.syncToken ?? null);
  } catch (e) {
    if (isGoogleCalendarNotLinkedError(e)) {
      return { ok: false, upserted: 0, deleted: 0, skippedProplaneOriginated: 0, reason: "not_connected" };
    }
    throw e;
  }

  if (page.syncTokenInvalid) {
    // Google's token is gone (410) — drop it and do exactly one fresh full
    // sync now, rather than recursing, so a single pull never doubles its
    // Google round trips.
    await saveGoogleCalendarConnection(db, uid, { syncToken: null }).catch(() => undefined);
    page = await listGoogleCalendarEventsForSync(db, uid, null);
  }

  let upserted = 0;
  let deleted = 0;
  let skipped = 0;
  let writeFailures = 0;
  const seenEventIds = new Set<string>();

  for (const event of page.events) {
    const recordId = googleMeetingRecordId(uid, event.id);
    if (event.status === "cancelled") {
      const { error } = await db.from("portal_schedule_records").delete().eq("id", recordId);
      if (error) writeFailures += 1;
      else deleted += 1;
      continue;
    }
    if (isProplaneOriginatedEvent(event.description)) {
      // PropLane's own pushed events (tours, work orders, availability
      // blocks) come back through the same sync feed as everything else on
      // the calendar. Mirroring them as `google_meeting` rows would double
      // them with their own PropLane-side record, so they are recognized by
      // the marker and dropped here rather than persisted.
      skipped += 1;
      continue;
    }
    if (!event.start || !event.end) continue;
    seenEventIds.add(event.id);
    const { error } = await db.from("portal_schedule_records").upsert(
      {
        id: recordId,
        manager_user_id: uid,
        property_id: null,
        record_type: "google_meeting",
        starts_at: event.start,
        ends_at: event.end,
        row_data: {
          googleEventId: event.id,
          summary: event.summary,
          start: event.start,
          end: event.end,
          transparency: event.transparency ?? "opaque",
          declinedBySelf: event.declinedBySelf === true,
          allDay: event.allDay === true,
          eventType: event.eventType ?? null,
          pulledAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) writeFailures += 1;
    else upserted += 1;
  }

  // A completed FULL sync is a snapshot of everything that still exists in
  // the window, so any mirrored row for that window the snapshot did not
  // return was deleted on Google while no token was tracking it (the 410 gap)
  // — purge it, or a cancelled meeting keeps blocking tours forever. A
  // truncated walk is only a prefix and must never be reconciled against.
  if (page.fullSyncWindow && !page.truncated && writeFailures === 0) {
    deleted += await purgeMirroredMeetingsAbsentFromSnapshot(db, uid, seenEventIds, page.fullSyncWindow);
  }

  const patch: Partial<GoogleCalendarConnection> = {};
  // The cursor only advances once every change Google reported has landed in
  // the mirror; a transient Supabase failure otherwise drops those changes
  // from every future incremental pull.
  if (page.nextSyncToken && !page.truncated && writeFailures === 0) patch.syncToken = page.nextSyncToken;

  const needsChannel =
    !connection.channelId ||
    !connection.channelExpiryMs ||
    connection.channelExpiryMs - Date.now() < CHANNEL_RENEWAL_WINDOW_MS;
  if (needsChannel) {
    try {
      const webhookUrl = `${resolveEmailLinkBaseUrl()}/api/portal/google-calendar/webhook`;
      // Google only accepts an HTTPS, domain-verified webhook address — never
      // localhost, never a *.vercel.app preview. Skip renewal quietly on a
      // host that cannot serve one; the poll-on-read call to this same
      // function is the fallback that keeps the mirror current either way.
      if (webhookUrl.startsWith("https://") && !webhookUrl.includes(".vercel.app/")) {
        const watch = await watchGoogleCalendar(db, uid, webhookUrl);
        if (watch) {
          patch.channelId = watch.channelId;
          patch.channelResourceId = watch.resourceId;
          patch.channelExpiryMs = watch.expiration;
        }
      }
    } catch (e) {
      console.warn(`[google-calendar] watch channel renewal failed for manager ${uid.slice(-6)}`, e);
    }
  }

  if (Object.keys(patch).length > 0) {
    await saveGoogleCalendarConnection(db, uid, patch).catch(() => undefined);
  }

  return {
    ok: writeFailures === 0,
    upserted,
    deleted,
    skippedProplaneOriginated: skipped,
    ...(writeFailures > 0 ? { reason: "mirror_write_failed" } : {}),
  };
}

async function purgeMirroredMeetingsAbsentFromSnapshot(
  db: SupabaseClient,
  managerUserId: string,
  seenEventIds: ReadonlySet<string>,
  window: { timeMin: string; timeMax: string },
): Promise<number> {
  try {
    const { data, error } = await db
      .from("portal_schedule_records")
      .select("id, row_data")
      .eq("record_type", "google_meeting")
      .eq("manager_user_id", managerUserId)
      .lt("starts_at", window.timeMax)
      .gt("ends_at", window.timeMin);
    if (error || !Array.isArray(data)) return 0;
    const stale = (data as { id: string; row_data: unknown }[]).filter((row) => {
      const payload =
        row.row_data && typeof row.row_data === "object" && !Array.isArray(row.row_data)
          ? (row.row_data as Record<string, unknown>)
          : null;
      const googleEventId = typeof payload?.googleEventId === "string" ? payload.googleEventId : "";
      return googleEventId !== "" && !seenEventIds.has(googleEventId);
    });
    if (stale.length === 0) return 0;
    const { error: deleteError } = await db
      .from("portal_schedule_records")
      .delete()
      .in("id", stale.map((row) => row.id));
    return deleteError ? 0 : stale.length;
  } catch {
    return 0;
  }
}
