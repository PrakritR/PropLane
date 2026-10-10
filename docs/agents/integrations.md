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

Airbnb and Booking.com are live and their row opens the one-page Connect popup
(`ChannelCalendarLinkModal`, `src/components/portal/channel-calendar-link-modal.tsx`);
Vrbo is "Coming soon" unless the workspace already has a Vrbo link, which keeps
working and stays manageable. SpareRoom, Furnished Finder and Apartments.com are
listed as Coming soon so a manager can see what is planned.

The popup is **one page, not a wizard**: channel → scope → a paste field per
unit. Scope is `SegmentedTwo` — **Entire workspace** or **specific properties** —
and an entire-home listing has one row ("Whole house"), a shared house one row
per room (`channelCalendarUnits`). An import URL must be that channel's own
export link (`isValidChannelImportUrl` per host + path; the error message names
the exact clicks on that channel's site), so the fetcher can never be pointed at
an arbitrary target.

**Each room row says where it stands**, because a two-way link is only live once
BOTH halves are done: the paste state (Linked / "Paste <channel> calendar link" /
"Feed failed · <error>"), whether PropLane's own export link has been taken yet
(Copied, or "Not yet pasted into <channel>"), and the two "last checked" facts
(`channelCheckFacts`, `channel-links.ts`): "Airbnb checked PropLane · 5:42 PM" and "PropLane checked Airbnb · 5:40 PM". Its ⋯ holds Sync now · Feed preview · Disconnect, plus
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
- **Remove.** A manager block can be cancelled until its last night has passed,
  **including one that already started** (`canCancelBooking`); a block with nobody
  attached is labelled "Remove" (`isReservedBlock`, `bookingCancelLabel`) in the row and
  record-page ⋯, behind the destructive confirm in `BookingsCancelDialog`. A resident (hold
  or lease) is never removed here.
- **Airbnb checked PropLane.** The export route stamps
  `external_calendar_connections.export_last_fetched_at` when the request's User-Agent
  contains "Airbnb" (`stampExportFetch`, `export-fetch-stamp.ts`): best-effort, never
  fails the feed, written at most every 5 minutes. **PropLane checked Airbnb** is the
  connection's `last_synced_at`. Both show on the booking record page and per room in the
  Connect popup.
- **Booking alerts.** `syncChannelCalendarConnection` diffs the new ranges against the
  connection's stored ones (`diffChannelReservations`, `channel-booking-diff.ts`) and
  emits `channel_booking_created` / `channel_booking_cancelled` on the action-event bus
  (`channel-booking-events.server.ts`): "New Airbnb booking · 5259 Brooklyn Ave · Room 3 ·
  Oct 12 – Oct 15 (3 nights)". Every path (cron, Sync, Sync all) ends in that one
  function, so a manual Sync alerts too. They ride the manager audience of the bus
  - the PropLane Assistant notice, which follows the alert destination to the work number
  - exactly like a confirmed tour. Never on a connection's first sync (the baseline),
  never for a host block, never for a stay that already ended, and idempotent on
  connection + stay (`eventId`), so a re-run does not notify twice. Copy carries no guest
  name; the payload keeps only what the feed exposes ("Reserved" when it hides the guest).
- **Echo suppression.** Airbnb mirrors PropLane's own export back as "Airbnb (Not
  available)". `isHostBlockRange` keeps that out of the alert diff, and
  `withoutEchoedHostBlocks` (`host-block.ts`) hides it in Bookings when it sits inside a
  PropLane stay on the same room.

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
every write re-checks on the server. Co-manager levels themselves are owned by
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
  add a "post for me" action.
- **Facebook Page auto-post** and **Instagram** are the two Meta rows. They read
  "Coming soon" (plain text, no control) until the Meta app is live
  (`META_APP_LIVE=1`, see [`listing-syndication.md`](listing-syndication.md)).
  Live: **Connect Facebook** (one OAuth per workspace, owner only), then
  "Connected as <Page>" with a disconnect icon; Instagram reads "Connected as
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
`channel-calendar-link-modal.test.tsx`.
