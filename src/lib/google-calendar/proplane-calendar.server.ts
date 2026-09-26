import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getGoogleCalendarAccessToken,
  googleCalendarFetchSignal,
  isGoogleCalendarNotLinkedError,
} from "@/lib/google-calendar/api.server";
import { saveGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";

/** Exact summary PropLane's dedicated secondary calendar is created/found with. */
export const PROPLANE_DEDICATED_CALENDAR_SUMMARY = "PropLane";

const PROPLANE_DEDICATED_CALENDAR_DESCRIPTION =
  "Created by PropLane. Holds every PropLane-managed event (tours, service visits, availability) " +
  "so PropLane never edits your other calendars. Safe to rename; do not delete while PropLane Calendar sync is on.";

type GoogleCalendarListEntry = { id?: string; summary?: string };

/**
 * Idempotently resolves (creating if needed) the dedicated "PropLane"
 * secondary calendar for this connection, and persists it as
 * `connection.writeCalendarId`.
 *
 * Best-effort by design: every caller treats a `null` return as "keep using
 * the primary calendar for writes" rather than a hard failure — a manager or
 * vendor whose OAuth consent predates the `calendar.app.created` scope (or
 * whose Google account rejects the call for any other reason) must still be
 * able to sync tours/service visits, just without the dedicated-calendar
 * isolation until they reconnect and re-grant it.
 */
export async function ensureProplaneCalendarId(
  db: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const uid = userId.trim();
  if (!uid) return null;

  let accessToken: string;
  try {
    const token = await getGoogleCalendarAccessToken(db, uid);
    if (token.connection.writeCalendarId) return token.connection.writeCalendarId;
    accessToken = token.accessToken;
  } catch (e) {
    if (isGoogleCalendarNotLinkedError(e)) return null;
    throw e;
  }

  // Look for a calendar this connection already created (a prior run that
  // created it but crashed before persisting the id) before creating a new
  // one — never mint duplicate "PropLane" calendars on retry.
  const existingId = await findExistingProplaneCalendar(accessToken).catch(() => null);
  const calendarId = existingId ?? (await createProplaneCalendar(accessToken).catch((e) => {
    debugGoogleCalendarLog("proplane-calendar.server.ts:ensureProplaneCalendarId", "create failed", {
      userSuffix: uid.slice(-6),
      message: e instanceof Error ? e.message : "unknown",
    });
    return null;
  }));
  if (!calendarId) return null;

  await saveGoogleCalendarConnection(db, uid, { writeCalendarId: calendarId }).catch(() => undefined);
  return calendarId;
}

async function findExistingProplaneCalendar(accessToken: string): Promise<string | null> {
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner&fields=items(id,summary)",
    { headers: { Authorization: `Bearer ${accessToken}` }, signal: googleCalendarFetchSignal() },
  );
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { items?: GoogleCalendarListEntry[] };
  const match = (data.items ?? []).find((item) => item.summary === PROPLANE_DEDICATED_CALENDAR_SUMMARY);
  return match?.id?.trim() || null;
}

async function createProplaneCalendar(accessToken: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: PROPLANE_DEDICATED_CALENDAR_SUMMARY,
      description: PROPLANE_DEDICATED_CALENDAR_DESCRIPTION,
    }),
    signal: googleCalendarFetchSignal(),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(data.error?.message ?? "Could not create the PropLane calendar.");
  }
  return data.id?.trim() || null;
}
