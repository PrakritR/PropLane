> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Settings → Integrations

**One page owns every outside service a workspace connects to.** Before this
page each channel grew its own settings row somewhere else (the Zillow feed sat
under Settings → Properties, the work number under Communication, the Airbnb
link only inside the Bookings calendar). There is now exactly one surface, and
a new channel is a row on it — never a new settings pane.

`ManagerIntegrationsPanel` (`src/components/portal/manager-integrations-panel.tsx`)
is the page. Its settings group id is still `spreadsheets` (the legacy id, kept
so saved links and deep links keep resolving) with the label **Integrations**,
so the deep link is `?tab=spreadsheets&integration=<messages|bookings|posting|google>`
(`INTEGRATIONS_TAB_PARAM`; `integration=spreadsheets` is accepted as a friendly
alias for the sub-tab whose id stays `google`). Four sub-tabs, left rail on
desktop and a scrolling strip on a phone:

| Tab | Panel | Owns |
| --- | --- | --- |
| **Messages** | `integrations-messages-panel.tsx` | Read-only rows for the workspace's work number and work email |
| **Bookings** | `integrations-bookings-panel.tsx` | The channels whose calendars PropLane syncs |
| **Posting** | `integrations-posting-panel.tsx` | Where a listing is advertised beyond PropLane |
| **Spreadsheets** | `manager-sheet-link-panel.tsx` | The workspace's linked spreadsheets (Google Sheet or published CSV) |

**Every row is an `IntegrationRow`** (`src/components/portal/integration-row.tsx`):
logo tile · name · one plain fact · action. A channel that is not built yet says
**"Coming soon"** in plain text where the action would be — never a badge and
never a pill, because portal rows carry none (AGENTS.md § Portal UI system).
The fact is a plain fact too, not a status chip:
"Connected · 2 of 3 rooms · both ways · synced 5 min ago · 1 needs a listing"
(`channelRowFact`, `src/lib/channel-calendar/channel-row-fact.ts` — it counts the
channel's linked rooms against every unit in scope, so a partly-linked channel says
so and its button still reads **Connect**), "(206) 555-0001", "Not set up",
"2 of 7 listings posting". A row that opens something instead of acting in place
passes `onOpen`: the whole row becomes a button (Enter / Space too) with a
trailing chevron — how the Listing sites rows open their per-site guide
([`listing-syndication.md`](listing-syndication.md)).

## Messages reads; it never edits

The work number and work email are rendered from `GET /api/manager/messaging-number`
and `GET /api/manager/assistant-email` for the ACTIVE workspace, and the row's
only action is **Manage**, which hands over to Communication settings. Setup,
sharing and announcements stay in one place — do not grow a second editing
surface here. The channels themselves are owned by
[`sms-system.md`](sms-system.md) and [`communication-inbox.md`](communication-inbox.md).

## Bookings: one popup connects a channel

This tab owns the **connection**. The Bookings screen the connection feeds —
what the calendar and the booking record draw, its five reads and its status
vocabulary — is owned by [`bookings.md`](bookings.md).

Airbnb and Booking.com are live and their row opens the one-page Connect popup
(`ChannelCalendarLinkModal`, `src/components/portal/channel-calendar-link-modal.tsx`);
Vrbo is "Coming soon" unless the workspace already has a Vrbo link, which keeps
working and stays manageable. SpareRoom and Apartments.com are listed as Coming
soon so a manager can see what is planned.

**Other calendar** (`provider: "ical"`) is the row for every site without a row of its
own - Houfy, Furnished Finder, Expedia, HomeToGo, Vrbo while it is Coming soon, anything
that publishes an https `.ics`. The manager types the site's name in the popup's **Name**
field; it is stored in the connection's existing `label` column and is what every label,
status line, alert ("New Houfy booking") and calendar bar says
(`channelCalendarProviderLabel(provider, label)`). There is no host allowlist (that is the
point), so `isValidIcalImportUrl` instead refuses what must never be fetched: http, a path
that is not `.ics` / `/ical/` / `/calendar/`, credentials in the URL, and loopback, private,
link-local or internal hosts (`ical-host.ts`). The fetch itself goes through
`fetchPinnedPublicHttps` (DNS resolved once, every address must be public, the connection is
pinned to those addresses, each redirect hop re-vetted), and the first response must be
`text/calendar` or start with `BEGIN:VCALENDAR`. The popup's check icon calls
`POST /api/portal/channel-calendar/validate` (manager session, rate limited, 6s cap,
returns the block count never the body). Import, export, sync, tombstones, echo suppression
and booking alerts are the Airbnb path unchanged.

A room can hold **several** Other calendar links, one per site name (Houfy and Furnished
Finder): uniqueness is `(property, room, provider)` for the other channels and
`(property, room, provider, lower(label))` for `ical` (two partial unique indexes,
`20261014010000_channel_calendar_ical_provider.sql`), and
`upsertChannelCalendarConnection` matches by hand rather than PostgREST `onConflict`
(an expression index cannot be targeted). Each link has its own export token, and the
export feed leaves out only ITS OWN connection's imports (`ownConnectionId` in
`importedRangesForFeed`): Houfy's feed carries Furnished Finder's stays and the reverse.
Removed-stay tombstones are keyed by provider, so two `ical` feeds on one room share a
tombstone namespace (a UID collision across two sites is the only way to cross-prune).

**The popup opens at once.** It used to read every stay of every linked room on open
(`fetchManagerChannelBookings`, capped at `PORTAL_READ_TIMEOUT_MS`), which on a 28-room
workspace exceeded 12s and surfaced "That took too long". The Integrations panel now reads
`?slim=1` (rooms and links, no stored `imported_ranges`, no tombstones, no guest-name
rows), passes the result to the popup as `initialConnections`, and the popup refreshes
behind itself: a slow or failed refresh keeps what is shown and never becomes a message.
The server read (`listManagerChannelCalendarBookings`) runs its per-house access checks and
property loads in parallel. The cap is not raised; the full read stays the Bookings
calendar's own ([`bookings.md`](bookings.md)). Coverage:
`tests/unit/channel-calendar-slim-read.test.ts`, `channel-calendar-ical-modal.test.tsx`.

The popup is **one page, not a wizard**: channel → scope → a paste field per
unit. Scope is `SegmentedTwo` — **Entire workspace** or **specific properties** —
and an entire-home listing has one row ("Whole house"), a shared house one row
per room (`channelCalendarUnits`). An import URL must be that channel's own
export link (`isValidChannelImportUrl` per host + path; the error message names
the exact clicks on that channel's site), so the fetcher can never be pointed at
an arbitrary target.

**Each room row says where it stands in one plain status line**, never a pill:
`channelStatusParts` / `channelStatusLine` (`channel-links.ts`) compose it as
state · the sides that have a timestamp — "Synced · Airbnb 8:04 AM · PropLane
8:00 AM", "Waiting for Airbnb · PropLane 8:00 AM" before the channel has fetched
the export feed once, "Not linked" with no import URL pasted, and a red
"Error:" lead carrying the feed's last error. (The Bookings record page still
shows the two labelled "last checked" facts through `channelCheckFacts`.) Its ⋯ holds Sync now · Feed preview · Disconnect, plus
**Copy Airbnb listing pack** on Airbnb only — `buildAirbnbListingPack`
(`src/lib/channel-calendar/listing-pack.ts`) composes the room's own listing facts
(32-character title, address, overview, amenities, house rules, a nightly price
derived from the room's monthly rent, and the photo list) into text the manager
pastes into Airbnb's own composer. It never posts anywhere and never invents a
photo: a data-URL photo is listed as "embedded photo (open the room in PropLane to
save it)" rather than a URL. **Sync all now** (footer) syncs every row in scope and
reports how many failed.

### Two-way with Airbnb

Airbnb has no public write API, so the two directions are not equally fast:

| Direction | How | Speed |
| --- | --- | --- |
| PropLane -> Airbnb | The per-room export feed (`/api/calendar/export/<token>.ics`) that Airbnb polls. Mark reserved / Remove on the Bookings calendar writes a `room_date_block`; the feed already carries it (a cancelled block drops out) | Instant in PropLane, then **whenever Airbnb next polls** (a few hours) |
| Airbnb -> PropLane | Our import sync: cron `sync-channel-calendars` every 15 minutes, plus **Sync** / **Sync all** | Up to 15 minutes, or immediate on a manual Sync |

- **Mark reserved.** Clicking an empty room-day (today or later) on the Bookings calendar
  opens `BookingsBlockDatesModal` with `mode="reserve"`: house, room and night
  prefilled, titled "Mark reserved", one **Save**. A room linked to Airbnb adds the fact
  row "Airbnb · Updates when Airbnb next checks PropLane" (`airbnbLinkForRoom`).
- **Unblock / Delete.** Taking a block back off the calendar — who may, what each
  action does and where it is offered — is owned by
  [`bookings.md`](bookings.md) § Blocks. What matters to the channel: both free the
  nights in the export feed (a cancelled block drops out of it, a deleted row is gone),
  so Airbnb reopens them at its next poll. A resident (hold or lease) is never removed
  here.
- **Airbnb checked PropLane.** The export route stamps
  `external_calendar_connections.export_last_fetched_at` when the request's User-Agent
  contains "Airbnb" (`stampExportFetch`, `export-fetch-stamp.ts`): best-effort, never
  fails the feed, written at most every 5 minutes. **PropLane checked Airbnb** is the
  connection's `last_synced_at`. Both show on the booking record page and per room in the
  Connect popup.
- **Booking alerts.** `syncChannelCalendarConnection` diffs the new ranges against the
  connection's stored ones (`diffChannelReservations`, `channel-booking-diff.ts`) and
  emits `channel_booking_created` / `channel_booking_cancelled` on the action-event bus
  (`channel-booking-events.server.ts`). Every path (cron, Sync, Sync all) ends in that one
  function, so a manual Sync alerts too. What the notice says, who it reaches, the check-in /
  check-out reminders that ride it and the domain allowlist the insert has to satisfy are owned
  by [`bookings.md`](bookings.md) § Booking alerts and reminders. The diff is what decides
  there is anything to alert about: never on a connection's first sync (the baseline),
  never for a host block, never for a stay that already ended, and idempotent on
  connection + stay (`eventId`), so a re-run does not notify twice. The payload keeps only
  what the feed exposes — no guest name, and "Reserved" when Airbnb hides it.
- **Who booked.** The feed never carries the guest's name, so a stay is identified from
  three things. Two are read off the event DESCRIPTION
  (`parseReservationDescription`, `reservation-details.ts`): the **reservation code**
  (`HM…`, taken only from a `https://www.airbnb.com/hosting/reservations/details/<code>`
  URL, and the Open-in-Airbnb link is rebuilt from the code — never the raw feed URL) and
  the guest's **phone ending** (last 4). Both show as fact rows on the booking record page;
  the raw description is never stored. The third is `channel_stay_details` — the name, phone,
  note and money a manager types or Airbnb's own notification mail to the work email fills in, owned
  by [`bookings.md`](bookings.md) § Airbnb money (the mail itself:
  [`inbound-email-inbox.md`](inbound-email-inbox.md) § Airbnb notifications). What this tab owns
  is the door: RLS is on with no client policy or grant, so `GET/PUT
  /api/portal/channel-calendar/stay-details` is the only way in, it needs Calendar `read` / `edit`
  on the connection's OWN house (a house id in the body is never read), and it only names a stay
  the connection still carries.
- **Echo suppression.** Airbnb mirrors PropLane's own export back as "Airbnb (Not
  available)". `isHostBlockRange` keeps that out of the alert diff, and
  `withoutEchoedHostBlocks` (`host-block.ts`) hides it in Bookings when that room's own
  stays cover it, and keeps only the uncovered remainder when they cover part of it —
  [`bookings.md`](bookings.md) § Airbnb echoes.

### A channel calendar is a WRITE on the house

**Linking, unlinking and syncing a channel calendar need the Calendar module at
`edit`** — `managerCanWriteCalendarForProperty` (and
`managerCanWriteCalendarForProperties` for a whole portfolio in two round
trips), never the `read` level that merely shows shared availability, and the
legacy `properties` read grant does not stand in for it. The **cache-miss read
path counts as a write too**: `GET …/connections?roomId=` mints a connection row
with its secret public export token, so it is gated at `edit` like the rest.
`GET …/connections?writableFor=<ids>` is how the popup lists only writable
houses (and scopes "Entire workspace" to them) — that is a **hint for the UI**;
every write re-checks on the server. **Blocking a room is the same write**: a
`room_date_block` belongs to the HOUSE, and the capacity trigger only accepts a
row stamped with the property owner, so `/api/portal-schedule-records` (and MCP
`block_room_dates`) stamps `manager_user_id` with the owner and keeps the author
in `row_data.createdByUserId` whenever a teammate holding Calendar at `edit`
blocks dates; anyone else is refused 403 rather than stamped. The stamp then
stays put for the row's whole life: an update restores the stored owner, and
changing or REMOVING a block (the cancelled-block write and the delete path)
re-checks Calendar `edit` on the block's own house, so a revoked grant stops
reaching a block it once created. Because the owner column is not the author, a
teammate's own blocks are listed by the writer's id in the record id
(`roomDateBlockRecordIdPrefix`, `portal-schedule-record-scope.ts`) — an insert
cannot claim another user's prefix — so they can still Remove what they just
blocked. Co-manager levels
themselves are owned by
[`co-manager-access.md`](co-manager-access.md); shared availability by
[`tours-scheduling.md`](tours-scheduling.md).

### The export link is built on the canonical server origin

`buildExportCalendarUrl` (`src/lib/channel-calendar/connections.server.ts`)
always produces `https://<canonical host>/api/calendar/export/<token>.ics` from
`NEXT_PUBLIC_CANONICAL_APP_URL` → `resolveEmailLinkBaseUrl()` →
`PRODUCTION_APP_ORIGIN`. The request origin is honoured **only** for a localhost
host and **only** outside `NODE_ENV=production`, so a lane server keeps its own
port while a production request arriving as `Host: localhost:3000` can never
hand a channel a URL it cannot fetch. The candidate origin is reduced by
`sanitizeCalendarOrigin` first (a client once sent it percent-encoded, which
produced a feed link Airbnb rejected). The client no longer sends an `origin`
query param at all — the route derives it with `resolveRequestOrigin`.
Coverage: `tests/unit/channel-calendar-export-url.test.ts`,
`channel-calendar-write-access.test.ts`.

## Posting

- **Show Listed with PropLane** — the one home of the workspace attribution
  switch (it is not on Promotion › Listing sites). `POST /api/manager/listing-channels/attribution`,
  owner only; the toggle is disabled whenever the plan forces the line on (the
  Free plan), because the write is refused rather than stored and ignored. What
  the line is and where it renders belongs to
  [`listing-syndication.md`](listing-syndication.md).
- **Zillow Rental Network** — one feed link per workspace, created on first read
  of `GET /api/manager/syndication-feed`, copied with the row's Copy icon
  action. The row's fact is "N of M listings posting", counted from each
  listing's own opt-in (`submission.syndication.zillow`). The feed itself — a
  `publicListingProjection` map and nothing wider — is owned by
  [`listing-syndication.md`](listing-syndication.md). Do not describe the feed's
  contents here.
- **Facebook Marketplace is Copy post only.** There is no rental-posting API for
  us (D11), so the row picks a listing, copies the post, and opens Facebook's own
  composer (`FACEBOOK_MARKETPLACE_CREATE_URL`). The post text comes from the one
  listing-site builder (`GET /api/manager/listing-channels?propertyId=`): the
  listing's public facts plus the workspace **work number and work email**. The
  post is published publicly, so its listing link is the canonical origin. Do not
  add a "post for me" action. Marketplace and Groups also offer a nightly **Copy short-stay post**
  for a listing that allows short stays — the builder and its refusals are owned by
  [`listing-syndication.md`](listing-syndication.md) § Short-stay post.
- **Facebook Page auto-post** and **Instagram** are the two Meta rows. They read
  "Coming soon" (plain text, no control) until the Meta app is live
  (`META_APP_LIVE=1`, see [`listing-syndication.md`](listing-syndication.md)).
  Live: **Connect Facebook** (one OAuth per workspace, owner only), then
  "Connected as <Page>" with a disconnect icon, and the Page row then also carries the fact
  "Replies: on" (the Messenger auto-reply, owned by
  [`listing-syndication.md`](listing-syndication.md) § Facebook Page replies);
  Instagram reads "Connected as
  @<name>" from the Page's linked account. Where each listing posts is switched
  on the listing's Promotion › Listing sites tab, not here.

## Spreadsheets

The tab (still section id `google`) is the Google account rows — Calendar
(`GoogleCalendarConnectPanel presentation="row"`) and Sheets — and then one row per
linked spreadsheet, each with a status pill, one fact line and a ⋯ (Update now ·
Settings · Remove); the "Add a spreadsheet" row's + opens the add popup
(`GET/POST/PATCH/DELETE /api/portal/sheet-link`, `src/lib/manager-sheet-link.ts`). A
workspace links as many as it likes. Scopes, the one OAuth client and the Console
steps are owned by [`google-integrations.md`](google-integrations.md). Per link:

- **Source** — a Google Sheet picked with the Drive picker (`drive.file`, so PropLane
  sees that one file), or a **published CSV** URL for a sheet the manager publishes
  instead of connecting Google. A published-CSV fetch is server-side and resolves
  every redirect hop itself, refusing any hop whose resolved IP is private,
  link-local or otherwise unroutable (`sheet-sync/public-host.server.ts`) — a pasted
  URL can never be pointed at an internal address.
- **Reads as** — `stays`, `occupancy` (the grid, plus house tabs and an optional
  Stays tab) or `raw`. Only `raw` caches the rows, first tab only and truncated at
  `RAW_CACHE_MAX_ROWS` × `RAW_CACHE_MAX_COLS`; that cache is for the assistant and is
  never sent to the browser (`publicManagerSheetBinding` publishes a count, not rows).
- **Refresh** — Every 15 minutes, Hourly, or Manual only. The cron
  (`/api/cron/sync-manager-sheets`, Vercel `*/15 * * * *`) syncs only the links that
  are actually due (`sheetLinkDueForSync`, one minute of grace); a link with no
  stored interval keeps the old 15-minute behaviour and a manual one is never synced
  by the cron. The pill is Live / Needs attention / Manual, where an auto-synced link
  that has not synced within twice its interval is **Needs attention** too
  (`sheetLinkStatus`) — a quietly stale sheet is not "live".

The assistant and external credentials reach the same links through
`list_spreadsheets` / `read_spreadsheet` (reads, clipped to a context budget) and
`sync_spreadsheet` (a previewed write, confirmed like every other) — catalogued in
[`../ai-assistant.md`](../ai-assistant.md) and exposed to REST keys under the
Workspace insights product area (`src/lib/mcp/capabilities.ts`).

Coverage for the page itself: `tests/unit/manager-integrations-panel.test.tsx`,
`integrations-channel-rows.test.tsx`, `integrations-messages-panel.test.tsx`,
`channel-calendar-link-modal.test.tsx`, `channel-calendar-ical*.test.ts*`.
