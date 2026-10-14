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
lease), `hold` (an approved application that has not been withdrawn, or a
manager's block held for a named person), `block` (a typed closed range with a
reason) and the channel feeds `airbnb` / `booking_com` / `vrbo`. The calendar
once drew channel ranges only, which made it read as an Airbnb widget while a
room let through PropLane itself looked free; every source lands in the same
shape so a day cell can answer "is this room taken" whatever took it.

A resident-backed entry carries that resident's OWN figures — `monthlyRent`,
`securityDeposit`, `leaseTerm`, `residentPhone` — and `bookingRateLabel`
(`booking-presentation.ts`) prints the resident's rent ahead of the room
listing's rate or a block's nightly rate, because the resident is who pays.

## Residents come from the occupancy snapshot

Every resident stay — an approved application's hold and an executed lease — is
drawn from the occupancy snapshot's own `stays[].resident` payload
(`OccupancyStayResident`, `src/lib/occupancy/snapshot.ts`), rebuilt into entries
by `residentEntriesFromStays`. That one server read already knows who is where
and when, so residents appear as soon as `/api/portal/occupancy` answers instead
of waiting on the much slower applications and lease-pipeline reads (the live
portfolio took ~30s there, which read as a calendar with no residents on it).

The applications and lease reads only **enrich** the same stay:
`mergeResidentEntries` matches an entry by source + `leaseId` / `applicationId`,
falling back to where-and-when for a stay the snapshot sent without record ids
(a calendar-only viewer — [`co-manager-access.md`](co-manager-access.md)
§ Calendar shows the stay). Never two rows for one stay, and never a second
resident source beside the snapshot.

Those lists un-draw a stay only on PROVEN absence: a lease or application the
snapshot named but the client list does not is orphaned data and stops holding
the room — but only once the applications answer was a **complete** manager-scope
list (`complete` on `ManagerApplicationsSyncResult`, i.e. not `truncated`, not
sitting at the read cap, same workspace). A partial answer is missing rows that
still exist, so absence there proves nothing. Coverage:
`tests/unit/bookings-residents-from-occupancy.test.tsx`.

## Five reads; one that fails never blanks the screen

`useManagerBookingEntries` (`src/hooks/use-manager-booking-entries.ts`) builds
the screen from five reads — `channel`, `occupancy`, `applications`, `blocks`,
`leases` — each capped at `PORTAL_READ_TIMEOUT_MS` (12s,
`src/lib/auth/fetch-with-timeout.ts`). A read that errors or times out is listed
in `failedSources`; everything that did load is still drawn, under one compact
`BookingsLoadFailedBand` ("Some bookings didn't load." · **Retry**, which re-runs
every source). The `channel` read is the full one (every stay of every linked room); the
Connect popup and the Integrations rows use the slim variant (`?slim=1`, no stored stays) and
the server runs its per-house checks in parallel, so a large workspace does not eat the cap
([`integrations.md`](integrations.md) § Bookings). Do not make a new source fatal to the
whole calendar, and do not grow a second error surface. Because residents come from the snapshot, a failed
`applications` or `leases` read is NOT a missing-bookings failure once
`occupancy` answered — it only cost the enrichment — and so stays out of
`failedSources` and off the band. Coverage:
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
reservation also Remove stay. A host block's Edit is the exception — it opens
the Block notes popup (§ Airbnb money), never the Add/Edit sheet.

## Booking alerts and reminders (Oct 12 2026)

- A new / cancelled channel booking is an `action_events` row in the `channel_booking` domain. The
  domain and category allowlists the bus's own insert has to satisfy are owned by
  [`../action-event-catalog.md`](../action-event-catalog.md) § Producer contract — a missing
  `channel_booking` entry there (until `20261013000000`) is why no alert ever went out, so the
  sync's best-effort catch now logs a warning instead of swallowing the refusal.
- The notice reads "New Airbnb booking · House · Room N · Oct 13 – Oct 16 (3 nights) · <code>" and links to the
  booking RECORD page (`bookingRecordUrl`), never the calendar. The Assistant thread shows an "Open booking"
  action for any notice whose body carries a record link (`bookingRecordPathFromNotice`).
- Check-in (9:00 PT the day before) and check-out (9:00 PT that morning) reminders ride the existing `booking`
  reminder kind for channel stays, holds and leases, to the owner and every teammate with the house; a host
  block ("Airbnb (Not available)") is never reminded. Each is its own subject (`…` and `…:out`), so a re-sweep
  never double-sends.
- `update_room_block` (assistant-only, not on MCP) edits a hold's dates, guest, phone and notes with the same
  overlap rule as `block_room_dates`; the three booking reads accept Calendar at notification or edit.

## Airbnb money (names, payouts)

The Airbnb feed carries no guest name and no money. `channel_stay_details`
(service-role only, keyed `connection_id + source_uid`, owner-scoped by the
connection; `20261009190000_channel_stay_details.sql` plus the money columns in
`20261013020000_channel_stay_details_money.sql`) holds what the manager types or
Airbnb's emails supply: `guest_name`, `guest_phone`, `notes`, `nightly_cents`,
`payout_cents`, `paid_at`, `currency`, `source` (`manual` or `airbnb_email`),
`check_in` / `check_out`. The booking record's Guest (Name, Phone) and Booking
(Nightly, Payout, Paid on) rows edit them through one popup
(`BookingsStayDetailsDialog`, one Save, `PUT .../stay-details`): a field left out
of the request is untouched, a blank clears it, and the row is deleted once it
holds no name, no note and no money. That route is the only door into the table,
and its permission gate is owned by [`integrations.md`](integrations.md)
§ Bookings: one popup connects a channel.

The popup's last field is a multi-line **Notes** — the manager's own note on the
stay, under that same one Save, drawn back as the record's Notes fact row
(`stayNotes`). On a **host block** the popup is the whole Edit action: the record
keeps its Edit icon (every other channel entry still hides it), the popup opens
titled **Block notes** with Notes alone, and it saves only `notes`. A note is
deliberately not money: `hasMoney` in `saveChannelStayDetails` ignores it, so a
note-only row is deleted when the note is cleared instead of lingering as an
empty row.

A host block's details row is keyed on its UID **plus its dates**
(`channelStayDetailsKey`, the same composite `channelStayTombstoneKey` uses):
Airbnb gives every block on one feed the same UID, so keying a note on the UID
alone would draw one block's note on another and let the second save overwrite
the first. The popup sends the RAW range's dates (`channelRangeStart` /
`channelRangeEnd` on a trimmed remainder) and the server derives the key from
its own stored range - the dates in the request only pick which block is meant.
A reservation keeps its UID-only key, so Mark paid and the Airbnb email intake
are unchanged. Coverage: `tests/unit/channel-stay-details.test.ts`,
`tests/unit/evidence-stay-notes-api-1013.test.ts`.

One label rule wherever a guest is drawn — list row, record title, day card,
payout row (`bookingEntryGuestLabel`): the typed name, else "Airbnb guest · HM…"
from the reservation code, else the feed summary. Host blocks and every
non-channel source keep their own label.

A stay with `payout_cents` projects an **Airbnb row in Incoming payments**
(`src/lib/channel-calendar/airbnb-payouts.ts`, `GET .../channel-calendar/payouts`):
tile AB, "Airbnb · <guest or code>", "Payout · house · room · dates", fact
"Paid <date>" or "Due <day after check-out>", figure the payout. It is Pending
until `paid_at` is set (Mark paid in the row's menu, or a payout email), then
Paid, and counts in the bucket totals. It is a projection: **never a household
charge**, so it has no reminders, selection or bulk actions.

Host step to get names and payouts automatically (forward Airbnb mail to the work
email): see `docs/agents/inbound-email-inbox.md` § Airbnb notifications.

## Short stays on the public listing ("Request to book")

A listing that allows short stays is ONE price card, on every width — phone included — with a **Monthly | Short stay** segment control. The segment appears only when the listing really can be booked: `offered` in `short-stay-booking.tsx` is the one predicate (short stays on, at least one room to hold, a nightly rate), so the card never prints "— / night" and a roomless listing keeps the Monthly side alone. Short stay draws the Airbnb-style block (`ShortStayBookingBlock`) inside that card: check-in / check-out, Room, Guests, a live "$X × N nights" total, **Request to book** (**Quick book** for a signed-in resident with saved answers) and a plain "Text <work number>" link. The card owns the one price line — `from $X / night` above the segments — so the block never prints a price header of its own. Dates narrow the rooms list through `shortStayRoomVerdict` (`src/lib/short-stay-request.ts`; check-out exclusive, anonymous occupancy spans only): taken rooms stay listed, dimmed, with "Booked <range> · free from <date>". **Request to book** posts to `POST /api/public/short-stay-request` (`src/lib/short-stay-request.server.ts`), which re-checks availability server-side (409 when taken, including the capacity trigger's refusal), then saves the same `room_date_block` hold the manager's Add booking sheet saves (guest on the block, `rate` = nightly with `rateBasis: "daily"`, quoted nights and total beside it), texts the guest from the work number, emails them when an address was given, and emits `channel_booking` / `short_stay_requested` to the owner and teammates. Nothing is charged and no resident account is made; the manager confirms in Bookings. Abuse guard: 10 requests a minute per IP, a hidden honeypot, check-in within 180 days, 1 to 28 nights. Coverage: `tests/unit/short-stay-request-lib.test.ts`, `tests/unit/short-stay-request-route.test.ts`, `tests/unit/short-stay-booking-card.test.tsx`.

## Quick book from an application (Oct 13 2026)

An **Approved** application row (captain, Oct 13: never Pending, Declined, withdrawn or unfinished; `applicationRowCanQuickBook` enforces it) has a **Quick book** icon (`CalendarPlus`) that opens the same Block dates sheet as Bookings, on Mark reserved, filled from the application: house and room from `parseRoomChoiceValue(roomChoice1)`, check-in `leaseStart`, check-out `leaseEnd` (the day after check-in when missing), the applicant as the resident (matched to a resident on the books by email, else a new resident) and reason `Application <id>`. The prefill is `quickBookPrefillForApplication` (`src/lib/channel-calendar/quick-book.ts`); an application with no room or move-in date toasts instead of opening. The host (`application-quick-book.tsx`) mounts only while open and saves through `useSaveBookingBlock`, the one save path Bookings also uses — never fork it, so a new resident gets the same invite either way.

Because the host starts the Bookings reads as it opens, it is the one sheet that opens on an empty
calendar, and both lists it decides on are empty for that moment: `entries` is the whole
double-booking guard (`saveRoomDateBlock` does no server-side overlap check) and `residentOptions` is
what tells a prefilled applicant already on the books apart from a NEW resident, who gets an
account-setup invite by text or email. So `useManagerBookingEntries` reports `readsPending` (every
source, not just the first — that is `loading`), the sheet takes it as a prop, and while it is true the
sheet fills and reads but will not save. Any future host that opens the sheet before its reads land
passes the same flag.

## Airbnb echoes

PropLane exports its residents, holds and blocks to Airbnb as unavailable, and Airbnb's feed returns them as host blocks ("Airbnb (Not available)"); `withoutEchoedHostBlocks` (`host-block.ts`, applied once in `use-manager-booking-entries.ts`) drops any host block covered by the union of that room's own stays and keeps only the uncovered remainder of a partly covered one, while reservations always draw and the raw `imported_ranges` stay untouched. It is literally the same subtraction occupancy runs on `echoable` spans — both call `coveringIntervals` + `uncovered` from `room-occupancy-rule.ts`, so a covered echo adds no blocked nights and a remainder does; there is no second copy to drift. A remainder carries `channelRangeStart`/`channelRangeEnd` (the raw imported range's dates), because a host block's identity is its UID plus those dates and Remove stay / Undo (and Block notes) would otherwise 404 on the trimmed ones. One uncovered day sitting exactly on a local stay's check-out is the channel re-exporting that exclusive check-out, not a free night, so it never draws - wherever in the block it falls, between two back-to-back residents as much as at the very end. Channel booking alerts already skip host blocks. Coverage:
`tests/unit/bookings-echo-blocks.test.ts`,
`tests/unit/evidence-bookings-notes-echo-1013.test.tsx`.
