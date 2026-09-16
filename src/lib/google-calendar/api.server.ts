import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type GoogleCalendarConnection,
  isGoogleCalendarOAuthConfigured,
  loadGoogleCalendarConnection,
  resolveGoogleCalendarOAuthConfig,
  saveGoogleCalendarConnection,
} from "@/lib/google-calendar/settings";
import { GOOGLE_CALENDAR_OAUTH_SCOPES } from "@/lib/google-calendar/scopes";
import { isKnownProductionWebHost, resolveShareableAppOrigin } from "@/lib/app-url";
import { sanitizeOAuthReturnPath } from "@/lib/auth/oauth-return-path";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { TOUR_HORIZON_MAX_DAYS } from "@/lib/tour-slot-math";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * "This manager has no working calendar link" — never "Google failed".
 *
 * A distinct type rather than a message convention, because callers classify on
 * it to decide whether to warn the manager, and the write calls rethrow
 * Google's own error text verbatim.
 */
export class GoogleCalendarNotLinkedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleCalendarNotLinkedError";
  }
}

function clientId(): string {
  const id = resolveGoogleCalendarOAuthConfig()?.clientId;
  if (!id) throw new GoogleCalendarNotLinkedError("Google Calendar is not configured.");
  return id;
}

function clientSecret(): string {
  const secret = resolveGoogleCalendarOAuthConfig()?.clientSecret;
  if (!secret) throw new GoogleCalendarNotLinkedError("Google Calendar is not configured.");
  return secret;
}

function stateSecret(): string {
  return clientSecret();
}

/**
 * OAuth redirect host — override when multiple dev ports share one Google redirect URI.
 *
 * On production we may serve multiple domains (prop-lane.space and the legacy Axis host).
 * Google Cloud typically allowlists one callback origin; map every live production host
 * to the deployment's canonical origin so Calendar connect works from any of them.
 *
 * `GOOGLE_CALENDAR_REDIRECT_ORIGIN` is for local multi-port dev only — never applied on
 * production hosts, or a laptop .env.local would break production OAuth callbacks.
 */
export function resolveGoogleCalendarRedirectOrigin(browserOrigin: string): string {
  const normalized = browserOrigin.replace(/\/$/, "");
  try {
    const { hostname } = new URL(normalized);
    if (isKnownProductionWebHost(hostname)) {
      return resolveShareableAppOrigin(normalized).replace(/\/$/, "");
    }
  } catch {
    /* fall through */
  }
  const override = process.env.GOOGLE_CALENDAR_REDIRECT_ORIGIN?.trim().replace(/\/$/, "");
  if (override) return override;
  return normalized;
}

export function googleCalendarOAuthRedirectUri(browserOrigin: string): string {
  return `${resolveGoogleCalendarRedirectOrigin(browserOrigin)}/api/portal/google-calendar/callback`;
}

export type GoogleCalendarOAuthState = {
  userId: string;
  returnOrigin: string;
  returnPath: string;
};

export function buildGoogleCalendarOAuthUrl(
  browserOrigin: string,
  managerUserId: string,
  returnPath?: string,
  opts?: { loginHint?: string | null },
): string {
  const returnOrigin = browserOrigin.replace(/\/$/, "");
  const redirectUri = googleCalendarOAuthRedirectUri(browserOrigin);
  const state = signOAuthState(managerUserId, returnOrigin, returnPath);
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_CALENDAR_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  const loginHint = opts?.loginHint?.trim();
  if (loginHint?.includes("@")) {
    params.set("login_hint", loginHint);
  }
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export function googleCalendarOAuthReturnTo(
  oauthState: GoogleCalendarOAuthState | null,
  fallbackOrigin: string,
  fallbackPath = "/portal/calendar",
): string {
  if (oauthState) {
    return `${oauthState.returnOrigin}${oauthState.returnPath}`;
  }
  return `${fallbackOrigin.replace(/\/$/, "")}${fallbackPath}`;
}

function signOAuthState(managerUserId: string, returnOrigin: string, returnPath?: string): string {
  const payload = JSON.stringify({
    uid: managerUserId,
    t: Date.now(),
    returnOrigin,
    ...(returnPath ? { returnPath } : {}),
  });
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}|${sig}`).toString("base64url");
}

export function verifyOAuthState(state: string): GoogleCalendarOAuthState | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep < 0) {
      debugGoogleCalendarLog("api.server.ts:verifyOAuthState", "state verify failed", {
        hypothesisId: "H17",
        reason: "no_separator",
      });
      return null;
    }
    const payload = decoded.slice(0, sep);
    const sig = decoded.slice(sep + 1);
    const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      debugGoogleCalendarLog("api.server.ts:verifyOAuthState", "state verify failed", {
        hypothesisId: "H17",
        reason: "bad_signature",
      });
      return null;
    }
    const parsed = JSON.parse(payload) as {
      uid?: string;
      t?: number;
      returnOrigin?: string;
      returnPath?: string;
    };
    if (!parsed.uid || typeof parsed.t !== "number") {
      debugGoogleCalendarLog("api.server.ts:verifyOAuthState", "state verify failed", {
        hypothesisId: "H17",
        reason: "bad_payload",
      });
      return null;
    }
    if (Date.now() - parsed.t > 15 * 60 * 1000) {
      debugGoogleCalendarLog("api.server.ts:verifyOAuthState", "state verify failed", {
        hypothesisId: "H17",
        reason: "expired",
      });
      return null;
    }
    const returnOrigin =
      typeof parsed.returnOrigin === "string" && parsed.returnOrigin.trim()
        ? parsed.returnOrigin.trim().replace(/\/$/, "")
        : null;
    if (!returnOrigin) {
      debugGoogleCalendarLog("api.server.ts:verifyOAuthState", "state verify failed", {
        hypothesisId: "H17",
        reason: "missing_return_origin",
      });
      return null;
    }
    return {
      userId: parsed.uid,
      returnOrigin,
      returnPath: sanitizeOAuthReturnPath(parsed.returnPath, "/portal/calendar"),
    };
  } catch (error) {
    debugGoogleCalendarLog("api.server.ts:verifyOAuthState", "state verify failed", {
      hypothesisId: "H17",
      reason: "parse_error",
      message: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

export async function exchangeGoogleCalendarCode(
  db: SupabaseClient,
  managerUserId: string,
  code: string,
  browserOrigin: string,
): Promise<GoogleCalendarConnection> {
  const redirectUri = googleCalendarOAuthRedirectUri(browserOrigin);
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: googleCalendarFetchSignal(),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    const detail = data.error_description?.trim() || data.error || "Could not connect Google Calendar.";
    throw new Error(detail);
  }

  const email = await fetchGoogleAccountEmail(data.access_token);
  const expiresAt =
    typeof data.expires_in === "number"
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null;

  const existing = await loadGoogleCalendarConnection(db, managerUserId);
  return saveGoogleCalendarConnection(db, managerUserId, {
    connected: true,
    email,
    syncEnabled: true,
    refreshToken: data.refresh_token ?? existing.refreshToken,
    accessToken: data.access_token,
    accessTokenExpiresAt: expiresAt,
    calendarId: existing.calendarId ?? "primary",
  });
}

async function fetchGoogleAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: googleCalendarFetchSignal(),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { email?: string };
  return data.email?.trim() || null;
}

async function refreshAccessToken(connection: GoogleCalendarConnection): Promise<{
  accessToken: string;
  expiresAt: string | null;
}> {
  if (!connection.refreshToken) {
    throw new GoogleCalendarNotLinkedError("Google Calendar session expired. Reconnect.");
  }
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: connection.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: googleCalendarFetchSignal(),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error ?? "Could not refresh Google Calendar session.");
  }
  const expiresAt =
    typeof data.expires_in === "number"
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null;
  return { accessToken: data.access_token, expiresAt };
}

export async function getGoogleCalendarAccessToken(
  db: SupabaseClient,
  managerUserId: string,
): Promise<{ connection: GoogleCalendarConnection; accessToken: string }> {
  if (!isGoogleCalendarOAuthConfigured()) {
    throw new GoogleCalendarNotLinkedError("Google Calendar is not configured.");
  }
  let connection = await loadGoogleCalendarConnection(db, managerUserId);
  if (!connection.connected || !connection.refreshToken) {
    throw new GoogleCalendarNotLinkedError("Google Calendar is not connected.");
  }
  const expiresAt = connection.accessTokenExpiresAt ? Date.parse(connection.accessTokenExpiresAt) : 0;
  const needsRefresh = !connection.accessToken || !expiresAt || expiresAt < Date.now() + 60_000;
  if (needsRefresh) {
    const refreshed = await refreshAccessToken(connection);
    connection = await saveGoogleCalendarConnection(db, managerUserId, {
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: refreshed.expiresAt,
    });
  }
  if (!connection.accessToken) {
    throw new GoogleCalendarNotLinkedError("Google Calendar session expired. Reconnect.");
  }
  return { connection, accessToken: connection.accessToken };
}

export type GoogleCalendarApiEvent = {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  htmlLink?: string;
  /** Google's `transparency`; `"transparent"` is the manager marking it Free. */
  transparency?: "opaque" | "transparent";
  /** True when the manager declined this invite on their own calendar. */
  declinedBySelf?: boolean;
  /** All-day entries arrive as bare dates and cover the whole calendar day. */
  allDay?: boolean;
  /**
   * Google's own event kind. `outOfOffice` and `focusTime` are Google's explicit
   * "I am not available" types and block whatever their transparency says.
   */
  eventType?: string;
};

export function isGoogleCalendarApiDisabledError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("calendar api") && (normalized.includes("disabled") || normalized.includes("has not been used"));
}

export function classifyGoogleCalendarEventsFetchError(message: string): {
  warning: string;
  hint: string;
} | null {
  const normalized = message.toLowerCase();
  if (isGoogleCalendarApiDisabledError(message)) {
    return {
      warning: "calendar_api_disabled",
      hint: "Enable the Google Calendar API in Google Cloud Console, then refresh this page.",
    };
  }
  if (normalized.includes("not configured")) {
    return {
      warning: "calendar_oauth_not_configured",
      hint: "Server is missing Google Calendar OAuth credentials. Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET, then restart the dev server.",
    };
  }
  if (normalized.includes("not connected") || normalized.includes("reconnect") || normalized.includes("expired")) {
    return {
      warning: "calendar_not_connected",
      hint: "Google Calendar is not linked yet. Use Continue with Google when creating your manager account, or connect from the Google Calendar button.",
    };
  }
  return null;
}

/** Pages of 250 events to walk before giving up; bounds a pathological calendar. */
export const GOOGLE_CALENDAR_EVENT_PAGE_LIMIT = 8;

/**
 * The whole timeout ladder for Google Calendar, derived from one number.
 *
 * EVERY budget here has to fire before the PLATFORM kills the request, or the
 * guard is inert and the caller sees a transport failure instead of the
 * degraded-but-honest result it was written to produce. Vercel's default Node
 * function limit is 10s on the smallest plan, and `maxDuration` is a
 * plan-dependent ceiling we deliberately do not assume, so the top of this
 * ladder stays comfortably under 10s.
 *
 * The three constants are derived rather than independently chosen, because
 * that is exactly how they drifted apart before: a whole-operation budget that
 * under-counted the call it wrapped reported a timeout for work still in
 * flight.
 */

/**
 * Per-round-trip ceiling on every Google Calendar call, INCLUDING the OAuth
 * token hops.
 *
 * Node's `fetch` has no default timeout, and these calls are AWAITED inside
 * request handlers. The token refresh needs it just as much:
 * `getGoogleCalendarAccessToken` refreshes whenever the token is within a minute
 * of expiry, so it is on the hot path of every call below.
 */
export const GOOGLE_CALENDAR_FETCH_TIMEOUT_MS = 3_000;

/**
 * Whole-walk ceiling on the paged event list, measured from the START of
 * `listGoogleCalendarEvents` so it covers the token hop as well as the pages.
 *
 * Two hops' worth: the walk always runs its first page, and starts a further one
 * only when a full {@link GOOGLE_CALENDAR_FETCH_TIMEOUT_MS} still fits inside
 * the budget — so this is a real bound, not a check that a page beginning just
 * under the deadline can overrun.
 */
export const GOOGLE_CALENDAR_EVENT_LIST_PAGING_BUDGET_MS = GOOGLE_CALENDAR_FETCH_TIMEOUT_MS * 2;

/**
 * The outer budget a caller races a whole paged READ against.
 *
 * Above the paging budget by one hop of slack, so it fires only for a genuine
 * stall rather than for a walk that was still going to finish.
 */
export const GOOGLE_CALENDAR_OPERATION_TIMEOUT_MS =
  GOOGLE_CALENDAR_EVENT_LIST_PAGING_BUDGET_MS + GOOGLE_CALENDAR_FETCH_TIMEOUT_MS;

/**
 * The outer budget for a WRITE (create / update / delete), which never pages.
 *
 * This is a WHOLE-OPERATION ceiling, NOT a sum of the Google legs — do not
 * "correct" it to `FETCH_TIMEOUT_MS * 2` on the theory that it wraps two
 * fetches. The operation a caller races also contains unbounded Supabase round
 * trips interleaved with the Google hops: `loadGoogleCalendarConnection` inside
 * the token hop before, and `deletePlannedTourByGoogleCalendarEventId` (cancel)
 * or `persistPlannedEventGoogleCalendarId` (reschedule) after. The value
 * happens to equal two fetch timeouts; the DB hops are covered by the same
 * ceiling rather than added to it, so a fully-stalled Google pair can trip it.
 *
 * Deliberately tighter than the read budget. A write runs on the cancel and
 * reschedule handlers, where it is NOT the first external call: the guest
 * notification (Resend email, consent-gated SMS) has already run, and those are
 * not bounded here. Leaving the Google leg most of the platform's function
 * budget would let a slow mailer get the whole request killed — the exact
 * "could not reach the server" for an already-committed change that bounding
 * this leg exists to prevent. Bounding the notification path belongs in its own
 * change; keeping real headroom for it does not.
 *
 * So a trip here reports the operation as unfinished when it may in fact have
 * landed. That is the accepted trade: `calendarSync.ok === false` shows the
 * manager a warning, which is recoverable, where a platform kill shows them a
 * failure for a change that already committed.
 */
export const GOOGLE_CALENDAR_WRITE_OPERATION_TIMEOUT_MS = GOOGLE_CALENDAR_FETCH_TIMEOUT_MS * 2;

/** `AbortSignal` bounding one Google Calendar round trip. */
export function googleCalendarFetchSignal(): AbortSignal {
  return AbortSignal.timeout(GOOGLE_CALENDAR_FETCH_TIMEOUT_MS);
}

/**
 * True for the states that mean "this manager has no working calendar link"
 * rather than "Google failed". Callers report these as SKIPPED, never as a
 * failure — `upsertGoogleCalendarEvent` returns null for the same states
 * without throwing, and the two paths must not disagree about it.
 *
 * Matches the SENTINEL TYPE, never the message text. The write calls rethrow
 * Google's own `error.message` verbatim, so substring-matching words like
 * "expired" or "reconnect" would silently reclassify a real remote failure as
 * success while the stale event survived and kept blocking a freed slot.
 */
export function isGoogleCalendarNotLinkedError(error: unknown): boolean {
  return error instanceof GoogleCalendarNotLinkedError;
}

export type GoogleCalendarListItem = {
  id?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  /** Google's own kind: "default" | "outOfOffice" | "focusTime" | "birthday" | … */
  eventType?: string;
};

/**
 * One Google list item as the busy layer reads it.
 *
 * The all-day bound is the sharp edge: Google reports an all-day `end.date`
 * EXCLUSIVELY — a one-day event on Aug 6 carries `end.date = 2026-08-07` — so
 * midnight ON that date is the first instant the event no longer covers.
 * Stretching it to `T23:59:59` made a single "Vacation" entry subtract two full
 * days of bookable tour slots from the public grid, and `overlaps()` already
 * treats the end as exclusive (`startMs < blockEndMs`).
 */
export function googleCalendarApiEventFromListItem(
  item: GoogleCalendarListItem,
): GoogleCalendarApiEvent | null {
  const allDay = !item.start?.dateTime && Boolean(item.start?.date);
  const start = item.start?.dateTime ?? (item.start?.date ? `${item.start.date}T00:00:00` : "");
  const end = item.end?.dateTime ?? (item.end?.date ? `${item.end.date}T00:00:00` : "");
  if (!item.id || !start || !end) return null;
  const self = item.attendees?.find((attendee) => attendee.self);
  return {
    id: item.id,
    summary: item.summary?.trim() || "Google Calendar event",
    description: item.description?.trim() || undefined,
    start,
    end,
    htmlLink: item.htmlLink,
    transparency: item.transparency === "transparent" ? "transparent" : "opaque",
    declinedBySelf: self?.responseStatus === "declined",
    allDay,
    eventType: typeof item.eventType === "string" ? item.eventType : undefined,
  } satisfies GoogleCalendarApiEvent;
}

export type GoogleCalendarEventsPage = {
  events: GoogleCalendarApiEvent[];
  /**
   * The walk stopped before the calendar did — the page bound or the time
   * budget cut it short.
   *
   * The loop below already DETECTS this and logs it, but a server-side
   * `console.warn` cannot reach the person looking at the grid. Results come
   * back ordered by start time, so the events dropped are the LAST ones in the
   * range — exactly the far weeks a wide busy window exists to cover. A caller
   * that renders those weeks as free, selectable time is offering a prospect an
   * hour the manager is not available, which is the double-booking failure the
   * busy overlay exists to prevent. So callers that let a manager act on the
   * grid must surface this rather than present a short list as a complete one.
   */
  truncated: boolean;
};

/** Array-returning form kept for existing callers; drops the truncation signal. */
export async function listGoogleCalendarEvents(
  db: SupabaseClient,
  managerUserId: string,
  timeMin: string,
  timeMax: string,
): Promise<GoogleCalendarApiEvent[]> {
  return (await listGoogleCalendarEventsPaged(db, managerUserId, timeMin, timeMax)).events;
}

export async function listGoogleCalendarEventsPaged(
  db: SupabaseClient,
  managerUserId: string,
  timeMin: string,
  timeMax: string,
): Promise<GoogleCalendarEventsPage> {
  // Started BEFORE the token hop, which is itself a Google round trip on the
  // hot path — a budget that began after it would not bound this call.
  const pagingDeadline = Date.now() + GOOGLE_CALENDAR_EVENT_LIST_PAGING_BUDGET_MS;
  const { connection, accessToken } = await getGoogleCalendarAccessToken(db, managerUserId);
  if (!connection.syncEnabled) return { events: [], truncated: false };
  const calendarId = encodeURIComponent(connection.calendarId ?? "primary");

  // Page rather than truncate: a single `maxResults` request silently dropped
  // the tail for a busy manager, and public tour availability subtracts these
  // windows — a missing event is a busy hour still on offer to a prospect.
  // ...but bound the WHOLE walk, not only each hop: sequential round trips would
  // otherwise stretch a public booking page far past any per-fetch ceiling.
  const items: GoogleCalendarListItem[] = [];
  let pageToken: string | undefined;
  let pagesWalked = 0;
  let stoppedBy: "page-limit" | "time-budget" = "page-limit";
  for (let page = 0; page < GOOGLE_CALENDAR_EVENT_PAGE_LIMIT; page += 1) {
    // A page begun just under the deadline still runs a full fetch timeout, so
    // require the headroom for one rather than merely checking the deadline.
    // The first page always runs — a read that returns nothing is worse than a
    // slow one. That makes the walk's true worst case token + one page, which is
    // what GOOGLE_CALENDAR_EVENT_LIST_PAGING_BUDGET_MS is sized for.
    if (page > 0 && Date.now() + GOOGLE_CALENDAR_FETCH_TIMEOUT_MS > pagingDeadline) {
      stoppedBy = "time-budget";
      break;
    }
    pagesWalked += 1;
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      // `eventType` is not returned by default on every response shape; ask for
      // the fields the busy predicate actually reads so an out-of-office entry
      // is recognizable as one.
      fields:
        "nextPageToken,items(id,summary,description,htmlLink,transparency,eventType,start,end,attendees(self,responseStatus))",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: googleCalendarFetchSignal() },
    );
    const data = (await res.json()) as {
      items?: GoogleCalendarListItem[];
      nextPageToken?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(data.error?.message ?? "Could not load Google Calendar events.");
    }
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  if (pageToken) {
    // Say so rather than silently under-subtracting the tail — an unread event
    // is a busy hour still on offer to a prospect, which is the whole failure
    // mode the pagination above exists to remove. Name the bound that actually
    // stopped the walk: the two have different knobs.
    console.warn(
      `[google-calendar] events truncated by ${stoppedBy} after ${pagesWalked} page(s) (${items.length} events) for manager ${managerUserId}; later busy time is not subtracted.`,
    );
  }

  return {
    events: items.map(googleCalendarApiEventFromListItem).filter(Boolean) as GoogleCalendarApiEvent[],
    truncated: Boolean(pageToken),
  };
}

export type GoogleCalendarSyncEvent = {
  id: string;
  /**
   * `"cancelled"` is a tombstone — Google guarantees only `id` and `status`
   * for it, so every other field (including `start`/`end`) is absent.
   */
  status: "confirmed" | "tentative" | "cancelled";
  summary: string;
  description?: string;
  start?: string;
  end?: string;
  transparency?: "opaque" | "transparent";
  declinedBySelf?: boolean;
  allDay?: boolean;
  eventType?: string;
};

export type GoogleCalendarSyncPage = {
  events: GoogleCalendarSyncEvent[];
  /** Present only on the page that finishes the walk; persist it for the next pull. */
  nextSyncToken?: string;
  /**
   * Google returned 410 Gone for the supplied `syncToken` — it is stale
   * (typically because the calendar's change history behind it expired).
   * The caller must drop the stored token and retry with a full sync; this
   * function does not retry itself, so ONE pull never doubles its Google
   * round trips.
   */
  syncTokenInvalid: boolean;
  /**
   * The page walk hit {@link GOOGLE_CALENDAR_EVENT_PAGE_LIMIT} with more pages
   * still behind it. `events` is then a prefix of the calendar, never the
   * whole of it, and no `nextSyncToken` is ever minted for it — the caller
   * must treat the result as "no cursor" and not reconcile against it.
   */
  truncated: boolean;
  /** The `[timeMin, timeMax)` a FULL sync walked; absent on an incremental (token) pull. */
  fullSyncWindow?: { timeMin: string; timeMax: string };
};

/**
 * How far back a FULL sync (no stored `syncToken`) looks for existing events.
 *
 * A sync token is calendar-wide going forward from the moment it is minted —
 * it is not scoped to this window — so this only bounds what the FIRST pull
 * backfills as `google_meeting` rows. A day of slack covers a meeting created
 * earlier today in a timezone ahead of the server's.
 */
const GOOGLE_CALENDAR_SYNC_FULL_WINDOW_PAST_DAYS = 1;

/**
 * How far ahead a FULL sync looks — the same ceiling the public busy read
 * (`googleBusyWindowEndMs`) can ask Google for. `singleEvents=true` expands
 * every recurring series into instances, so an unbounded walk over a busy
 * calendar ran past the page limit on every poll-on-read, never minted a
 * token, and re-upserted thousands of rows each time the calendar was opened.
 */
const GOOGLE_CALENDAR_SYNC_FULL_WINDOW_FUTURE_DAYS = TOUR_HORIZON_MAX_DAYS;

/**
 * Incremental (or first full) pull of a manager's calendar for
 * `pullGoogleCalendarMeetings`.
 *
 * Mirrors {@link listGoogleCalendarEventsPaged}'s page-walk and per-hop
 * timeout discipline, but reads `status` (so a cancelled event is a tombstone
 * to delete, not a row to upsert) and requests `showDeleted` — neither of
 * which the busy/display path needs, so that path is left untouched.
 *
 * `syncToken` and `timeMin` are mutually exclusive on Google's API: passing
 * both is a 400. A supplied token always wins; the full-sync window is used
 * only when there is none.
 */
export async function listGoogleCalendarEventsForSync(
  db: SupabaseClient,
  managerUserId: string,
  syncToken: string | null,
): Promise<GoogleCalendarSyncPage> {
  const { connection, accessToken } = await getGoogleCalendarAccessToken(db, managerUserId);
  if (!connection.syncEnabled) return { events: [], syncTokenInvalid: false, truncated: false };
  const calendarId = encodeURIComponent(connection.calendarId ?? "primary");
  const token = syncToken?.trim() || null;
  const dayMs = 24 * 60 * 60 * 1000;
  const fullSyncWindow = token
    ? undefined
    : {
        timeMin: new Date(Date.now() - GOOGLE_CALENDAR_SYNC_FULL_WINDOW_PAST_DAYS * dayMs).toISOString(),
        timeMax: new Date(Date.now() + GOOGLE_CALENDAR_SYNC_FULL_WINDOW_FUTURE_DAYS * dayMs).toISOString(),
      };

  const events: GoogleCalendarSyncEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  for (let page = 0; page < GOOGLE_CALENDAR_EVENT_PAGE_LIMIT; page += 1) {
    const params = new URLSearchParams({
      maxResults: "250",
      showDeleted: "true",
      singleEvents: "true",
      fields:
        "nextPageToken,nextSyncToken,items(id,status,summary,description,transparency,eventType,start,end,attendees(self,responseStatus))",
    });
    if (token) {
      params.set("syncToken", token);
    } else if (fullSyncWindow) {
      params.set("timeMin", fullSyncWindow.timeMin);
      params.set("timeMax", fullSyncWindow.timeMax);
    }
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: googleCalendarFetchSignal() },
    );
    if (res.status === 410) {
      return { events: [], syncTokenInvalid: true, truncated: false };
    }
    const data = (await res.json().catch(() => ({}))) as {
      items?: (GoogleCalendarListItem & { status?: string })[];
      nextPageToken?: string;
      nextSyncToken?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(data.error?.message ?? "Could not sync Google Calendar events.");
    }
    for (const item of data.items ?? []) {
      if (!item.id) continue;
      if (item.status === "cancelled") {
        events.push({ id: item.id, status: "cancelled", summary: "" });
        continue;
      }
      const mapped = googleCalendarApiEventFromListItem(item);
      if (!mapped) continue;
      events.push({ ...mapped, status: item.status === "tentative" ? "tentative" : "confirmed" });
    }
    pageToken = data.nextPageToken;
    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
    if (!pageToken) break;
  }

  const truncated = Boolean(pageToken);
  return {
    events,
    nextSyncToken: truncated ? undefined : nextSyncToken,
    syncTokenInvalid: false,
    truncated,
    fullSyncWindow,
  };
}

/** Result of standing up a push-notification channel (`events.watch`). */
export type GoogleCalendarWatchResult = {
  channelId: string;
  resourceId: string;
  /** Epoch ms; Google's own `expiration` when present, else a 7-day estimate. */
  expiration: number;
};

function signGoogleCalendarChannelToken(managerUserId: string): string {
  // Same HMAC shape as `signOAuthState` above, kept separate because a
  // channel token's validity window (the channel's own ~7-day lifetime, not
  // the 15-minute OAuth redirect window) is a different invariant.
  const payload = JSON.stringify({ uid: managerUserId, t: Date.now() });
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}|${sig}`).toString("base64url");
}

/**
 * Recovers the manager id from a channel token the webhook route received,
 * or `null` if it does not verify. Google's push notification carries no
 * other trustworthy identity — the channel/resource ids are visible to
 * anyone who can guess them, so the token (signed, never sent to the
 * browser) is what the webhook actually trusts.
 */
export function verifyGoogleCalendarChannelToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep < 0) return null;
    const payload = decoded.slice(0, sep);
    const sig = decoded.slice(sep + 1);
    const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(payload) as { uid?: string; t?: number };
    if (!parsed.uid || typeof parsed.t !== "number") return null;
    // A channel lives at most ~7 days; a generous outer bound rather than
    // reading the channel's own expiry, which the token does not carry.
    if (Date.now() - parsed.t > 8 * 24 * 60 * 60 * 1000) return null;
    return parsed.uid;
  } catch {
    return null;
  }
}

/**
 * Stands up (or replaces) a Google push-notification channel for this
 * manager's calendar so the webhook route gets notified of changes instead of
 * relying solely on the poll-on-read fallback. `webhookUrl` must be a
 * domain-verified HTTPS address — Google rejects anything else outright.
 */
export async function watchGoogleCalendar(
  db: SupabaseClient,
  managerUserId: string,
  webhookUrl: string,
): Promise<GoogleCalendarWatchResult | null> {
  const { connection, accessToken } = await getGoogleCalendarAccessToken(db, managerUserId);
  if (!connection.syncEnabled) return null;
  const calendarId = encodeURIComponent(connection.calendarId ?? "primary");
  const channelId = `axis-gcal-${managerUserId}-${Date.now()}`;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/watch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: channelId,
      type: "web_hook",
      address: webhookUrl,
      token: signGoogleCalendarChannelToken(managerUserId),
    }),
    signal: googleCalendarFetchSignal(),
  });
  const data = (await res.json().catch(() => ({}))) as {
    resourceId?: string;
    expiration?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(data.error?.message ?? "Could not create Google Calendar watch channel.");
  }
  if (!data.resourceId) return null;
  const expiration = Number(data.expiration);
  return {
    channelId,
    resourceId: data.resourceId,
    expiration: Number.isFinite(expiration) ? expiration : Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
}

/** Best-effort teardown — a 404 (already gone) is not an error. */
export async function stopGoogleCalendarWatch(
  db: SupabaseClient,
  managerUserId: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  const trimmedChannel = channelId.trim();
  const trimmedResource = resourceId.trim();
  if (!trimmedChannel || !trimmedResource) return;
  const { accessToken } = await getGoogleCalendarAccessToken(db, managerUserId);
  const res = await fetch("https://www.googleapis.com/calendar/v3/channels/stop", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: trimmedChannel, resourceId: trimmedResource }),
    signal: googleCalendarFetchSignal(),
  });
  if (!res.ok && res.status !== 404) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(data.error?.message ?? "Could not stop Google Calendar watch channel.");
  }
}

export type GoogleCalendarEventWriteInput = {
  /** Optional caller-owned id for retry-safe inserts. Google event ids accept
   * lowercase base32hex; callers must provide an already-valid value. */
  id?: string;
  title: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  /**
   * Google's own free/busy flag. Omitted (Google's default `"opaque"`, i.e.
   * busy) for every confirmed tour and work order — those must keep blocking
   * the manager's personal time. `"transparent"` is used only for pushed
   * availability blocks ("Open for tours"), which should appear on Google
   * without making the manager look busy.
   */
  transparency?: "opaque" | "transparent";
};

export class GoogleCalendarWriteSupersededError extends Error {
  constructor() {
    super("Google Calendar event changed before the tour update could be applied.");
    this.name = "GoogleCalendarWriteSupersededError";
  }
}

type GoogleCalendarConditionalWrite = {
  /** Called after the provider version is read and immediately before PATCH. */
  validateCurrent: () => Promise<boolean>;
};

function googleCalendarEventBody(input: GoogleCalendarEventWriteInput) {
  return {
    summary: input.title,
    description: input.description,
    location: input.location,
    start: { dateTime: input.start },
    end: { dateTime: input.end },
    ...(input.transparency ? { transparency: input.transparency } : {}),
  };
}

export async function createGoogleCalendarEvent(
  db: SupabaseClient,
  managerUserId: string,
  input: GoogleCalendarEventWriteInput,
  conditionalWrite?: GoogleCalendarConditionalWrite,
): Promise<string | null> {
  const { connection, accessToken } = await getGoogleCalendarAccessToken(db, managerUserId);
  if (!connection.syncEnabled) return null;
  const calendarId = encodeURIComponent(connection.calendarId ?? "primary");
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...(input.id ? { id: input.id } : {}), ...googleCalendarEventBody(input) }),
    signal: googleCalendarFetchSignal(),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok) {
    // A retry after Google accepted the insert but before our local save sees
    // the same deterministic id as already present. Reconcile the body now,
    // rather than merely accepting the id: the local tour may have moved to a
    // new window while the first create was in flight.
    if (res.status === 409 && input.id) {
      return updateGoogleCalendarEvent(db, managerUserId, input.id, input, conditionalWrite);
    }
    throw new Error(data.error?.message ?? "Could not create Google Calendar event.");
  }
  return data.id?.trim() || null;
}

export async function updateGoogleCalendarEvent(
  db: SupabaseClient,
  managerUserId: string,
  eventId: string,
  input: GoogleCalendarEventWriteInput,
  conditionalWrite?: GoogleCalendarConditionalWrite,
): Promise<string | null> {
  const trimmedId = eventId.trim();
  if (!trimmedId) return null;
  const { connection, accessToken } = await getGoogleCalendarAccessToken(db, managerUserId);
  if (!connection.syncEnabled) return null;
  const calendarId = encodeURIComponent(connection.calendarId ?? "primary");
  const encodedEventId = encodeURIComponent(trimmedId);
  let ifMatch: string | null = null;
  if (conditionalWrite) {
    const current = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodedEventId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: googleCalendarFetchSignal(),
      },
    );
    const currentData = (await current.json().catch(() => ({}))) as { etag?: string; error?: { message?: string } };
    if (!current.ok) throw new Error(currentData.error?.message ?? "Could not read Google Calendar event version.");
    ifMatch = current.headers.get("etag")?.trim() || currentData.etag?.trim() || null;
    if (!ifMatch) throw new Error("Google Calendar event version was unavailable.");
    if (!await conditionalWrite.validateCurrent()) throw new GoogleCalendarWriteSupersededError();
  }
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodedEventId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(ifMatch ? { "If-Match": ifMatch } : {}),
      },
      body: JSON.stringify(googleCalendarEventBody(input)),
      signal: googleCalendarFetchSignal(),
    },
  );
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok) {
    if (conditionalWrite && res.status === 412) throw new GoogleCalendarWriteSupersededError();
    throw new Error(data.error?.message ?? "Could not update Google Calendar event.");
  }
  return data.id?.trim() || trimmedId;
}

export async function deleteGoogleCalendarEvent(
  db: SupabaseClient,
  managerUserId: string,
  eventId: string,
): Promise<void> {
  const trimmedId = eventId.trim();
  if (!trimmedId) return;
  const { connection, accessToken } = await getGoogleCalendarAccessToken(db, managerUserId);
  if (!connection.syncEnabled) return;
  const calendarId = encodeURIComponent(connection.calendarId ?? "primary");
  const encodedEventId = encodeURIComponent(trimmedId);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodedEventId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: googleCalendarFetchSignal(),
    },
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(data.error?.message ?? "Could not delete Google Calendar event.");
  }
}
