# Google integrations

Every Google product PropLane touches — manager and vendor Calendar, the
Sheets/Drive picker, and Google sign-in — shares one OAuth client
(`GOOGLE_CALENDAR_CLIENT_ID`/`GOOGLE_CALENDAR_CLIENT_SECRET`) and one signed
state format. This file is the map: scopes per product and why, the two-way
Calendar sync design, and the exact Google Cloud Console steps that remain
(code cannot change Console configuration).

## Scopes, per product, and why

| Product | Scopes requested | Why |
| --- | --- | --- |
| Manager/vendor Calendar connect | `calendar.events`, `calendar.app.created`, `userinfo.email` | `calendar.events` reads busy time across the user's own calendars (needed to subtract personal events from public tour availability) and is the fallback write scope for a connection that predates the dedicated calendar. `calendar.app.created` lets PropLane create ONE secondary calendar (`calendars.insert`) and fully manage events on calendars it created, without ever gaining access to a calendar it did not create — this is what backs the dedicated "PropLane" write calendar (see below). `calendars.insert` is NOT covered by `calendar.events` alone (that scope is Events-resource only), which is why both are listed. |
| Sheets/Drive picker connect | `drive.file`, `userinfo.email` | `drive.file` grants access to exactly the file the Picker returns — nothing else in Drive. The Sheets API honours that same grant for reads on that file, so no separate Sheets scope is needed. Google does not classify `drive.file` as sensitive or restricted, so it needs no verification review (`src/lib/sheet-sync/google-sheets-auth.ts`). `spreadsheets.readonly` and `drive.metadata.readonly` were deliberately dropped in an earlier pass (BUILD-WAVE2 C210) — both are broader than one file, and `drive.metadata.readonly` is Google-restricted. |
| Google sign-in (Supabase Auth) | Supabase's default (`openid email profile`) only | Sign-in intentionally does NOT request the Calendar scope — see `src/lib/auth/google-oauth-calendar.ts`. A manager connects Calendar progressively, afterward, through the dedicated `/connect` flow, so consent is explicit and scoped rather than bundled into account creation. |

**Never requested, anywhere in code:** any Gmail scope (including
`gmail.readonly`). Confirmed by exhaustive grep — every `gmail` hit in `src/`
is either a display label for PropLane's own inbox channel enum, an example
`@gmail.com` address in copy/fixtures, or a comment. If the Google Cloud
Console's data-access review lists `gmail.readonly` as ever granted to this
OAuth client, it is a stale Console-side grant, not something the app
requests — see the Console steps below.

## Two-way Calendar sync

### The dedicated "PropLane" calendar

Every PropLane-authored write (a confirmed tour, a service visit, a pushed
availability block) now targets a dedicated SECONDARY calendar named
"PropLane", created on connect via `calendars.insert`
(`src/lib/google-calendar/proplane-calendar.server.ts`,
`ensureProplaneCalendarId`) and stored as `connection.writeCalendarId`
(`src/lib/google-calendar/settings.ts`). Reads for busy-time subtraction keep
using the user's PRIMARY calendar (`connection.calendarId`, unchanged) — only
the write target moved.

This means PropLane never edits a manager's or vendor's own events: it writes
only to a calendar it created and controls. Creation is best-effort and
non-fatal — an older connection (or one where creation fails for any reason,
including a Google account that has not yet re-granted
`calendar.app.created`) keeps writing to the primary calendar until it
reconnects, via `resolveGoogleCalendarWriteId`'s fallback
(`src/lib/google-calendar/api.server.ts`).

### PropLane → Google

- **Manager**: confirmed tours (`syncPlannedTourToGoogleCalendar`), work
  orders/service visits (`syncWorkOrderToGoogleCalendar`), and painted tour
  availability as transparent "Open for tours" events
  (`syncManagerAvailabilityToGoogleCalendar`) — all in
  `src/lib/google-calendar/sync.server.ts`, unchanged in behavior except for
  now targeting the dedicated calendar.
- **Vendor (new)**: `syncVendorServiceVisitToGoogleCalendar` and
  `syncVendorAvailabilityToGoogleCalendar`
  (`src/lib/google-calendar/vendor-calendar-push.server.ts`) push a vendor's
  own assigned service visits and painted availability
  (`vendor_availability_rules` / `vendorAvailabilityStorageKey`) to the
  VENDOR's own connected Google account. Both are gated on
  `connection.vendorPushEnabled` (default **off**), a flag independent of
  `syncEnabled` — a vendor who only wants their Google busy time read into
  PropLane (the pre-existing, read-only behavior) sees nothing new written
  until they opt in from the vendor Calendar page's toggle. Wired
  automatically from `syncWorkOrderToGoogleCalendar` whenever a work order has
  an assigned `vendorUserId`, so every existing manager-side call site keeps
  working unchanged. The remote event id is stored separately
  (`row.vendorGoogleCalendarEventId`, distinct from the manager's own
  `row.googleCalendarEventId`) since manager and vendor connect different
  Google accounts.
- Availability export for vendors covers painted slot blocks only. A vendor
  "unavailable" marker beyond that (a dedicated busy-block concept distinct
  from simply not painting a slot) does not exist as a data model yet — out
  of scope here; flagged as a known limitation.

### Google → PropLane

- **Busy time** (unchanged): `pull.server.ts` mirrors the user's OTHER
  calendar events (from the PRIMARY calendar) into `portal_schedule_records`
  as `google_meeting` rows for the public tour-availability subtraction and
  the manager/vendor calendar's busy overlay. PropLane-authored events are
  recognized by a description marker (`PROPLANE_GOOGLE_CALENDAR_MARKER`,
  `src/lib/google-calendar/markers.ts`) and skipped here — they are reconciled
  separately, below.
- **A PropLane-authored event edited or deleted on Google (new)**: this half
  never existed before. `pullProplaneCalendarPendingChanges`
  (`src/lib/google-calendar/proplane-calendar-reconcile.server.ts`) walks the
  dedicated write calendar's own incremental sync feed (a separate cursor,
  `connection.proplaneSyncToken`, from the busy-mirror's `syncToken`) and, for
  every PropLane-owned tour or service visit Google reports changed or
  deleted, writes a `google_calendar_pending_changes` row — **never** applying
  the change automatically. A manager or vendor sees these as attention items
  on the Calendar page (`GoogleCalendarPendingChangesBanner`) and explicitly:
  - **Accepts** — applies Google's version to the PropLane record. A tour goes
    through `mutateConfirmedTourSchedule`'s `"replace"` operation, the same
    guarded boundary a manual reschedule uses (locks the record, validates the
    expected current window, replaces atomically) — never a hand-rolled
    write. A deletion cancels the PropLane record through the existing cancel
    path. A work order's time is written directly to `scheduledAtIso` (no
    guarded reschedule RPC exists for work orders today — a narrower path than
    the tour one; flagged as a follow-up below).
  - **Dismisses** — keeps PropLane's version and re-pushes it to Google,
    overwriting the user's change.

  Deliberately scoped to the write calendar only: a connection without a
  `writeCalendarId` yet (see above) has no dedicated calendar to walk, so it
  gets no reconciliation until it reconnects — diffing the PRIMARY calendar
  indiscriminately would misclassify a manager's own personal edits as
  "PropLane conflicts."

### Vendor read of Calendar/Sheets: no change needed

The vendor `/api/vendor/google-calendar/events` route stays read-only busy
time exactly as before — this change ADDS a write path (above), it does not
touch the existing read path.

## Connect reliability, per product

- **Redirect URI per environment** (already correct, verified, no change):
  `resolveGoogleCalendarRedirectOrigin` (`api.server.ts`) canonicalizes a
  known production host to the shareable app origin, explicitly excludes
  Vercel preview hosts from that canonicalization (a preview keeps its own
  origin), and honors `GOOGLE_CALENDAR_REDIRECT_ORIGIN` for local multi-port
  dev only. Sheets reuses this exact function — no separate, potentially
  drifting redirect-URI logic. **Gap that remains (Console-side, not code):**
  a `*.vercel.app` preview gets a NEW subdomain per deploy, so it can only work
  if that exact URL is pre-registered — there is no way to register a moving
  target in Google Cloud Console. Preview OAuth connect is not expected to
  work; production and stable dev ports are.
- **State/CSRF**: an HMAC-SHA256-signed, 15-minute-expiring `state`
  (`signOAuthState`/`verifyOAuthState`), keyed by the OAuth client secret,
  verified with `timingSafeEqual`. No PKCE — correctly so: PKCE exists for
  PUBLIC clients that cannot hold a secret (mobile/SPA apps calling Google
  directly); this is a confidential server-side client with `client_secret`
  held server-side only, which is the case PKCE is not required for.
- **`access_type=offline` + `prompt=consent`**: already set on every
  `buildGoogleCalendarOAuthUrl` call, unconditionally — a manager/vendor
  always gets a fresh refresh token on connect (no "only when no refresh
  token" branch to get wrong).
- **Token refresh with retry / revoked-grant handling (new)**:
  `refreshAccessToken` (Calendar) and `getGoogleSheetsAccessTokenDetailed`
  (Sheets) now recognize Google's `invalid_grant`/`invalid_token` token-
  endpoint errors specifically and proactively mark the connection
  disconnected (`connected: false`, tokens cleared, `revoked: true`) instead
  of leaving `connected: true` forever on a dead refresh token and throwing an
  opaque error on every future call. The status API exposes `revoked` so the
  UI can offer "Reconnect Google Calendar" instead of a bare "Connect" for
  this specific case (`GoogleCalendarConnectPanel`).
- **Granular-consent handling (new)**: `exchangeGoogleCalendarCode` inspects
  the token response's `scope` field (when Google returns one) and refuses to
  save a connection that was granted without `calendar.events` — with a clear
  message telling the manager to check the Calendar box and reconnect, rather
  than silently saving a connection that can never sync anything.
- **"App blocked/unverified" errors**: unchanged, already handled —
  `isGoogleCalendarOAuthBlocked`/`GOOGLE_CALENDAR_UNVERIFIED_APP_STEPS`
  (`connect-errors.ts`) recognize `access_denied`/blocked/sensitive-scope text
  and walk the manager through Advanced → "Go to PropLane (unsafe)", or add
  their account under Test users.
- **Picker `setAppId`**: already wired (an earlier pass, BUILD-WAVE2 C210) —
  `googlePickerAppId()` derives the GCP project number from the OAuth client
  id's own prefix (`<project-number>-xxxx.apps.googleusercontent.com`), no
  separate env var needed, and `google-spreadsheet-picker.tsx` calls
  `.setAppId(...)` on the builder when present.
- **A vendor's Disconnect/sync-toggle bug, found and fixed**:
  `GoogleCalendarConnectPanel`'s `disconnect()` and `toggleSync()` both
  hardcoded `/api/portal/google-calendar` instead of using the `apiBase` prop
  the component already accepts for exactly this purpose. A vendor
  (`apiBase="/api/vendor/google-calendar"`) clicking Disconnect or toggling
  sync silently hit the MANAGER's endpoint — a pure vendor account could never
  disconnect Calendar or turn sync off from the UI. Fixed to use `apiBase`;
  regression test: `tests/unit/google-calendar-connect-panel-apibase.test.tsx`.

## Remaining Google Cloud Console steps (cannot be done from code)

1. **Remove `gmail.readonly` from the OAuth consent screen's sensitive/
   restricted scopes list.** Console → APIs & Services → OAuth consent screen
   → Data access → Edit. No code in this repo requests it (see the scopes
   table above); if it is listed as ever granted, it is a stale Console-side
   grant from history, safe to remove without touching this codebase.
2. **Declare only the scopes code actually uses.** Console → OAuth consent
   screen → Data access: `.../auth/calendar.events`,
   `.../auth/calendar.app.created`, `.../auth/drive.file`,
   `.../auth/userinfo.email` (plus whatever Supabase's own sign-in already
   needs — `openid`, `email`, `profile`). Nothing else.
3. **Submit `calendar.events` (and, if the review UI separates it,
   `calendar.app.created`) for sensitive-scope verification.** Both are
   sensitive-tier, not restricted — a lighter review than a Gmail-tier
   restricted scope, but a manager outside the Testing-mode allowlist still
   sees Google's "unverified app" warning until this completes. Suggested
   justification text for the review form:

   > PropLane is a residential property-management platform. With explicit,
   > per-user OAuth consent, it creates one dedicated secondary calendar
   > ("PropLane") per connected account and writes only to that calendar —
   > tours, maintenance visit schedules, and the user's own published
   > availability — so it never edits the user's personal calendar events.
   > It also reads the user's existing calendars read-only to avoid double-
   > booking a time the user has already marked busy elsewhere. Users
   > disconnect at any time from their account settings, which revokes
   > PropLane's access and stops all reads and writes immediately.

4. **Add every environment's exact redirect URI** under Credentials → the
   OAuth client → Authorized redirect URIs — one path shared by every product
   (Calendar, Sheets, sign-in all use `/api/portal/google-calendar/callback`):
   `https://<production-domain>/api/portal/google-calendar/callback`,
   `https://<staging-domain>/api/portal/google-calendar/callback` (if staging
   is ever OAuth-tested), and each stable local dev port actually used, e.g.
   `http://localhost:3000/api/portal/google-calendar/callback` through
   whatever port range this team's `docs/agents/AGENTS-*.md` assigns. Preview
   (`*.vercel.app`) deploys cannot be pre-registered (a new subdomain per
   deploy) — do not expect OAuth connect to work there.
5. **Keep the Test users list current** while the app is unverified/Testing —
   every manager or vendor account used for QA needs to be added there, or
   they hit the "app is blocked" screen entirely rather than the Advanced →
   "Go to PropLane (unsafe)" bypass (which only appears for an account that
   IS on the Test users list, or after verification completes).

## Known follow-ups (not built here)

- Work order "accept" (see Google → PropLane above) writes `scheduledAtIso`
  directly rather than through a guarded reschedule RPC — no such boundary
  exists for work orders today the way `mutateConfirmedTourSchedule` exists
  for tours. Worth building if work orders grow their own conflicting-writer
  problem the way tours once did.
- Vendor "availability blocks" export covers painted slot windows
  (`vendor_availability_rules` / `vendorAvailabilityStorageKey`) only — there
  is no separate vendor "mark busy" concept to export beyond that.
- The two-way pending-changes reconciliation runs on read (when the Calendar
  page is open), the same "poll-on-read" pattern the busy-mirror pull already
  uses — there is no dedicated push-notification (`events.watch`) channel for
  the write calendar. Acceptable for now (mirrors the existing precedent and
  its documented rationale — Testing-mode OAuth apps cannot always take live
  push on an unverified webhook domain), but a future pass could add one.
