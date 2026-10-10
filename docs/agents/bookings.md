> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Bookings (the manager's occupancy screen)

This file owns the Bookings **surface**: what it draws, where its rows come
from, how it behaves when one source does not load, and what a booking record
page shows. It deliberately owns nothing else — do not restate these here:

| Also about Bookings, owned elsewhere | Owner |
| --- | --- |
| Connecting a channel, the two-way Airbnb link, Mark reserved / Remove, blocking a room as a Calendar write | [`integrations.md`](integrations.md) § Bookings: one popup connects a channel |
| Counting beds, host blocks, capacity arbitration, the public availability endpoint | [`shared-room-capacity.md`](shared-room-capacity.md) |
| Which viewer may read a resident's money off a stay | [`co-manager-access.md`](co-manager-access.md) § Calendar shows the stay |
| The record-page and day-page shells themselves | [`record-page.md`](record-page.md) § The day page pattern |
| Notify guest on cancel, and removing a channel stay with a tombstone | [`communication-inbox.md`](communication-inbox.md) § Bookings: notices and removed stays |
| `list_bookings` / `list_room_blocks` / `block_room_dates` / `check_room_availability` | [`../ai-assistant.md`](../ai-assistant.md), [`mcp-api.md`](mcp-api.md) |

## One entry shape, six sources

`PropertyBookingEntry` (`src/lib/channel-calendar/property-bookings.ts`) is the
one row every Bookings screen draws, from six sources: `proplane` (an executed
lease), `hold` (an approved application, or a manager's block held for a named
person), `block` (a typed closed range with a reason) and the channel feeds
`airbnb` / `booking_com` / `vrbo`. The calendar once drew channel ranges only,
which made it read as an Airbnb widget while a room let through PropLane itself
looked free; every source lands in the same shape so a day cell can answer "is
this room taken" whatever took it.

A resident-backed entry carries that resident's OWN figures — `monthlyRent`,
`securityDeposit`, `leaseTerm`, `residentPhone` — and `bookingRateLabel`
(`booking-presentation.ts`) prints the resident's rent ahead of the room
listing's rate or a block's nightly rate, because the resident is who pays.

## Five reads; one that fails never blanks the screen

`useManagerBookingEntries` (`src/hooks/use-manager-booking-entries.ts`) builds
the screen from five reads — `channel`, `occupancy`, `applications`, `blocks`,
`leases` — each capped at `PORTAL_READ_TIMEOUT_MS` (12s,
`src/lib/auth/fetch-with-timeout.ts`). A read that errors or times out is listed
in `failedSources`; everything that did load is still drawn, under one compact
`BookingsLoadFailedBand` ("Some bookings didn't load." · **Retry**, which re-runs
every source). Do not make a new source fatal to the whole calendar, and do not
grow a second error surface. Coverage:
`tests/unit/bookings-failed-sources.test.tsx`.

## Status is derived from the dates, never stored

`bookingStatusLabel` (`booking-presentation.ts`) is the label a row or record
prints — **Hold · Confirmed · In-house · Checked out · Cancelled** — and
`calendarStatus` (`bookings-calendar-view.ts`) the one a calendar cell colours,
which adds **Blocked** and names the channel for an imported stay. Both derive
from the entry's own dates against today: an approved applicant whose dates have
started is **In-house**, not holding the room. The label is a plain fact on a
row, never a pill (AGENTS.md § Portal UI system) — and Confirmed says nothing at
all, because it is the default.

Occupancy figures on Calendar (`calendarOccupancySummary`) exclude unconfirmed
holds from the picture without touching capacity arbitration, and read through
`occupancyForDay`; bed totals come from `bookingOccupancyCapacities`
(`bookings-room-counts.ts`), the one bridge between the client listing store and
the framework-free occupancy math — Σ `occupancyCapacity`, never `rooms.length`.

## Buckets, routes and what is editable

`MANAGER_BOOKING_BUCKETS` (`src/lib/portal-detail-routes.ts`) is **Calendar
(default) · Upcoming · In-house · Past**. Stays and Occupancy are not tabs: the
range's "n of N occupied", check-ins and check-outs live on Calendar, and the
old `stays` / `occupancy` URLs redirect there rather than dead-ending.

A booking has no stored id of its own, so `bookingEntryKey` (source, property,
room, dates, summary) is reused verbatim as the record id — it can never collide
with a bucket keyword or a day key. Record tabs are `BOOKING_DETAIL_TABS`:
**overview · guest · payments · communication** (`charges` lands on payments,
`documents` / `activity` on overview). Overview carries the stay's facts and,
when it is resident-backed, Rent · Deposit · Lease term; Payments is the stay
total or rate plus that household's charges, each linking to its own payment
record. Only a manager-made hold is editable in place (the one combined
Add/Edit sheet); any other source offers Message and Copy link, and a channel
reservation also Remove stay.
