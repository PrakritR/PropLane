/**
 * Google OAuth scopes requested only when a manager or vendor explicitly
 * connects Calendar.
 *
 * `calendar.events` covers reading busy time across every calendar the user
 * already has (needed to subtract personal/other-calendar busy time from
 * public tour availability) and is also the fallback write scope for any
 * connection that has not yet had a dedicated PropLane calendar created.
 *
 * `calendar.app.created` is additive and narrower than the base `calendar`
 * scope: it lets PropLane create ONE secondary calendar
 * (`calendars.insert`) and fully manage events on calendars it created,
 * without ever gaining access to a calendar it did not create. That is the
 * scope backing `ensureProplaneCalendarId` (`proplane-calendar.server.ts`) —
 * once a dedicated "PropLane" calendar exists, every PropLane-authored write
 * (tours, service visits, availability blocks) targets that calendar instead
 * of the user's primary one, so PropLane never edits the user's own events.
 * `calendars.insert`/`calendars.delete` are NOT covered by `calendar.events`
 * alone (that scope is Events-resource only), which is why this is listed
 * separately rather than assumed to already be covered.
 */
export const GOOGLE_CALENDAR_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");
