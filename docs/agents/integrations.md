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
(`INTEGRATIONS_TAB_PARAM`). Four sub-tabs, left rail on desktop and a scrolling
strip on a phone:

| Tab | Panel | Owns |
| --- | --- | --- |
| **Messages** | `integrations-messages-panel.tsx` | Read-only rows for the workspace's work number and work email |
| **Bookings** | `integrations-bookings-panel.tsx` | The channels whose calendars PropLane syncs |
| **Posting** | `integrations-posting-panel.tsx` | Where a listing is advertised beyond PropLane |
| **Google** | `manager-sheet-link-panel.tsx` | The Sheets/Drive link |

**Every row is an `IntegrationRow`** (`src/components/portal/integration-row.tsx`):
logo tile · name · one plain fact · action. A channel that is not built yet says
**"Coming soon"** in plain text where the action would be — never a badge and
never a pill, because portal rows carry none (AGENTS.md § Portal UI system).
The fact is a plain fact too, not a status chip: "Connected · 3 rooms",
"(206) 555-0001", "Not set up", "2 of 7 listings posting".

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

## Google

The Sheets/Drive link, unchanged by this page beyond moving under a tab. Scopes,
the one OAuth client and the Console steps are owned by
[`google-integrations.md`](google-integrations.md).

Coverage for the page itself: `tests/unit/manager-integrations-panel.test.tsx`,
`integrations-channel-rows.test.tsx`, `integrations-messages-panel.test.tsx`,
`channel-calendar-link-modal.test.tsx`.
