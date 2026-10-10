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

The popup is **one page, not a wizard**: channel → a paste field per unit. There
is no scope picker — connecting a channel always covers the **entire workspace**
(every property the caller may write), and an entire-home listing has one row
("Whole house"), a shared house one row per room (`channelCalendarUnits`). An
import URL must be that channel's own export link (`isValidChannelImportUrl` per
host + path; the error message names the exact clicks on that channel's site), so
the fetcher can never be pointed at an arbitrary target.

**The paste box shows the link that is already saved**, with a Copy action beside
it, so a manager can read back what PropLane is fetching instead of guessing from
a "Connected" placeholder. Only a value that differs from the saved one is sent;
**emptying a box that had a link unlinks that channel** (row status "Link will be
removed", toast "Calendar link removed") and clears the stays that feed had
imported, since nothing is left to re-sync them. PropLane's own export token
survives — throwing that away is what ⋯ Disconnect is for.

**Each room row says where it stands**, because a two-way link is only live once
BOTH halves are done: the paste state (Connected / Ready to connect / "Link not
valid" / "Feed failed · <error>"), whether PropLane's own export link has been taken yet
(Copied, or "Not yet pasted into <channel>"), and "Last sync <relative>"
(`relativeSyncTime`). Its ⋯ holds Sync now · Feed preview · Disconnect, plus
**Copy Airbnb listing pack** on Airbnb only — `buildAirbnbListingPack`
(`src/lib/channel-calendar/listing-pack.ts`) composes the room's own listing facts
(32-character title, address, overview, amenities, house rules, a nightly price
derived from the room's monthly rent, and the photo list) into text the manager
pastes into Airbnb's own composer. It never posts anywhere and never invents a
photo: a data-URL photo is listed as "embedded photo (open the room in PropLane to
save it)" rather than a URL. **Sync all now** (footer) syncs every row in scope and
reports how many failed.

### A host block is not a reservation

A channel exports the host's OWN calendar blocks alongside real stays, and they
are not the same thing: nobody holds the bed. `isHostBlockSummary` /
`isHostBlockRange` / `withoutHostBlocks`
(`src/lib/channel-calendar/host-block.ts`) are the one decision, matched on the
WHOLE summary (optionally wrapped in the channel's name, as Airbnb writes it) —
`not available`, `blocked`, `unavailable`, never a substring, and deliberately
**not** `Reserved`, because Booking.com and VRBO privacy-strip real reservations
to "CLOSED - Not available" and reading one of those as a block would publish an
occupied room as free. A sync stamps `hostBlock` on the imported range; ranges
stored before the flag existed are derived from their summary.

A host block therefore: reads as "<channel> block" in the Bookings calendar
(`bookingGuestLabel`) and still closes those dates there, but it is never a
resident (`icalGuestStaysForResidents`), never a double-booking conflict
(`conflictingChannelStays`), never a bed against a room's capacity when an
application is placed or a move-out checked (`manualBlockPlacements`,
`checkMoveOutAvailabilityForLease` — see
[`shared-room-capacity.md`](shared-room-capacity.md)), and **never re-exported**
in PropLane's own feed, where it would echo straight back to the channel it came
from. `isIcalAvailabilityBlock` (`src/lib/occupancy/snapshot.ts`) stays
deliberately WIDER: it is "a bed with no name on it", which includes `Reserved`
and the privacy-stripped stays, and every host block is one of those too.

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
every write re-checks on the server. **The saved import URL is a bearer secret**
(anyone holding it reads the channel's reservations outside PropLane), so
`listManagerChannelCalendarBookings` returns `importUrl` only for the properties
the viewer may write — the same bar as linking it — and a view-only teammate gets
`hasImportUrl` alone. The bookings route that carries it answers
`Cache-Control: private, no-store`. Co-manager levels themselves are owned by
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

**What the feed publishes is scoped by PROPERTY, never by `manager_user_id`.** A
row's manager stamp is whoever authored it (the acting teammate in a co-managed
workspace, or a previous owner), while the connection carries the property's
current owner — filtering on the pair dropped every resident the owner had not
personally added and published their nights as free. The feed token already pins
one property, so a row naming that property is that property's occupancy whoever
wrote it; the same rule governs `occupancySnapshotForManager`.

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
