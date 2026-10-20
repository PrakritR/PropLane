> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Bookings (the manager's occupancy screen)

This file owns the Bookings **surface**: what it draws, where its rows come
from, how it behaves when one source does not load, and what a booking record
page shows. It deliberately owns nothing else — do not restate these here:

| Also about Bookings, owned elsewhere | Owner |
| --- | --- |
| Connecting a channel, the two-way Airbnb link, Mark reserved, blocking a room as a Calendar write | [`integrations.md`](integrations.md) § Bookings: one popup connects a channel |
| Counting beds, host blocks, capacity arbitration, the public availability endpoint | [`shared-room-capacity.md`](shared-room-capacity.md) |
| Which viewer may read a resident's money off a stay | [`co-manager-access.md`](co-manager-access.md) § Calendar shows the stay |
| The record-page and day-page shells themselves | [`record-page.md`](record-page.md) § The day page pattern |
| Notify guest on cancel, and removing a channel stay with a tombstone | [`communication-inbox.md`](communication-inbox.md) § Bookings: notices and removed stays |
| `list_bookings` / `list_room_blocks` / `block_room_dates` / `check_room_availability` | [`../ai-assistant.md`](../ai-assistant.md), [`mcp-api.md`](mcp-api.md) |

## One entry shape, seven sources

`PropertyBookingEntry` (`src/lib/channel-calendar/property-bookings.ts`) is the
one row every Bookings screen draws, from seven sources: `proplane` (an executed
lease), `hold` (an approved application that has not been withdrawn, or a
manager's block held for a named person), `block` (a typed closed range with a
reason) and the channel feeds `airbnb` / `booking_com` / `vrbo` / `ical` (an
"Other calendar" entry also carries `channelLabel`, the site the manager named —
[`integrations.md`](integrations.md) § Bookings). The calendar
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
sitting at the read cap, no row the route had to skip, same workspace). A partial
answer is missing rows that still exist, so absence there proves nothing. Coverage:
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

## The calendar grid at scale (Oct 18 2026)

`BookingsPortfolioTimeline` (+ `bookings-timeline-bar.tsx`, `bookings-timeline-layout.ts`) is one scroller with
a sticky day header and a sticky label column. **Every sticky surface is opaque** (`bg-[var(--pl-surface-raised)]`):
`--card` is translucent on the portal's light surface, which is how day labels showed through "Room" and bars
painted behind the labels. Bars and the occupancy strip live only in the track, positioned in px from the
measured column width (`columnPx`: Week fits a 390px phone, Month scrolls), never under the label column.
A multi-room house is a collapsible row (collapsed by default past three houses, remembered per page, opened by a
search or room filter); only expanded houses lay out rooms, and rows are windowed from 60 rows up. The house line
reads `8/10 tonight · 69% avg` (beds on the focus day, then the range average) and the KPI strip is four
tiles - never a peak beside an average percent. Search matches house, room and guest
(`narrowHouseBySearch`), and a hidden stay still keeps its nights busy. A bar under 56px draws its name beside it;
a bar's name is `position: sticky` inside an `overflow-clip` bar. Phone taps open a bottom sheet
(`BookingBarSheet`), desktop keeps the non-modal popover, mounted on first use (a Radix menu per bar is slow).
Dev proof: `/dev-fixtures/bookings-scale` (100 houses x 10 rooms; 404s outside `next dev`).
Coverage: `tests/unit/bookings-timeline-scale.test.tsx`.

## Exact times, half-day bars, paid early / late (Oct 18 2026)

**Dates stay authoritative; times ride beside them.** One pure module, `src/lib/bookings/stay-times.ts`, owns every time rule:
defaults, `resolveStayTimes`, `staysOverlap`, `halfDayBarSpan`, `stayAddOnAvailability` and `bookingTimeline`. Never derive a
time a second way.

- **Property defaults** live at `listingSubmission.stayTimes` and are edited in the listing editor's Basics step, section
  "Check-in and check-out" (every listing). Defaults: check-in 3:00 pm, check-out 11:00 am, cleaning buffer 3 h, earliest early
  check-in 12:00 pm, latest late checkout 2:00 pm, each add-on $25. `publicListingProjection` publishes the times and the two
  prices, never the buffer. The zone is the property's ZIP (`propertyTimeZoneForZip`). The server read is
  `loadPropertyStayClock` (`bookings/property-stay-times.server.ts`).
- **A stay row** (`room_date_block`) always carries `row_data.checkInTime` / `checkOutTime` ("HH:MM" property wall time), plus the
  real instants in `starts_at` / `ends_at`.
  - Every writer goes through `stampStayRow` (`bookings/stay-stamp.ts`). The save's own time wins, else the stored row's, else the
    legacy `stayDetails.earlyCheckIn/lateCheckOut`, else the default.
  - `stayDetails.addOns` is carried from the STORED row only, so a body never sets a paid add-on.
  - `residentUserId` is server-owned. `/api/portal-schedule-records` drops it from the body and keeps the stored one, because the
    stay charge, the guest's Stays and the guest's texts (door code included) are all keyed on it.
  - The Add/Edit sheets' Check-in / Check-out dropdowns are the manager's override. An imported channel stay takes the defaults,
    and its override is `channel_stay_details.check_in_at/check_out_at` (Edit on the stay).
- **Overlap compares wall times.** An 11:00 am out and a 3:00 pm in on the same day is not a double booking.
  - `20261018220000_booking_exact_times.sql` makes the capacity trigger sweep `[checkIn + checkInTime, checkOut + checkOutTime)`.
    The time comes from the row, else the property's stayTimes, else 15:00 / 11:00. A default-time stay compares exactly as the old
    date sweep did.
  - The same migration backfilled stays at Pacific: every live house is Pacific, and any later save corrects the instants.
  - Long-term placements (`assert_room_placement_capacity`) stay day-granular.
- **Half-day bars** (`layoutRoom`):
  - A check-in at or after noon starts mid-cell. A check-out at or before noon ends mid-cell. A same-day turnover is two half bars
    in one lane.
  - Lanes and conflicts use `staysOverlap`. Nights, the strip and the KPI tiles still count days.
  - At a turnover the bars stop short of a full-height block: slate hatch when a cleaning run exists (`useTurnoverCleaningRuns`,
    an optional read that is never a failed source), red hatch when the gap is under the buffer.
  - Tap title: "Brandi · out Oct 19, 11:00 am", with Check-in / Check-out / add-on fact rows.
  - A Clock glyph marks a PAID add-on.
- **Paid early check-in / late checkout** (`short-stay/stay-add-ons*.ts`, `GET/POST /api/resident/stays/[blockId]/add-ons`).
  - **Identity, price and availability.** Identity is the session; the stay must be this login's. Price and window come from the
    property's stayTimes. An add-on is offered only when `stayAddOnAvailability` holds against the room's other live stays: the
    previous guest out plus the buffer for early, the next check-in minus the buffer for late. It is re-checked at request, at
    confirm and at payment.
  - **The charge.** The charge is `hc_mgr_stay_<slug>_<kind>`, idempotent, and carries `guestStayBlockId` + `stayAddOn`. It never
    carries `shortStayBookingId`. A hold stores `requested`, and the charge is raised on Approve / instant confirm.
  - **Paid.** Paid (webhook, never while processing) moves the stay's time and calls `refreshTurnoverCleaningTimes`. It texts the
    guest and posts a `channel_booking` notice.
  - **Can't be honored.** That includes a trigger P4001. The add-on is refunded automatically, keyed
    `stay-add-on-refund:<chargeId>:<cents>`.
  - **Booking flow.** Book again and the public card take an Estimated arrival plus add-on checkboxes (from the dry run).
  - **By text.** Read-only `get_my_stay_times` (resident registry, SMS included) answers with the price and a pay link to the
    guest's Stays sheet. The guest pays there; the model never charges.
- **Times drive texts** (`bookingTimeline`, reminder kinds `stay_arrival_guide` / `stay_checkout_reminder`,
  `reminders/subjects/stay-times.server.ts`, no new cron).
  - **Who gets them.** Only to the guest of a CONFIRMED stay with a login.
  - **When.** The arrival guide goes 24 h before check-in; it is quiet-hour held but never sent after check-in. The checkout reminder
    goes at 8:00 am on checkout day.
  - **What the guide says.** It is built at send time from `houseInfo` (`bookings/arrival-guide.ts`). The door code goes only in that
    guest's own message and is never stored in the queue.
  - **Cleaning runs.** They take the window checkout → next check-in (`vendor-dispatch/turnover-window.ts`).
  - **The manager's switch.** Each text is a Settings → Automations row (`arrival_guide` / `checkout_reminder`). It is
    on or off only, default on, and is read at send time (`loadOffPresetResolver`). There is no draft and no editable
    text, because the body carries the door code and is built from house facts when it is sent.
- **iCal.** The export stays DATE values, because Airbnb imports dates only. An import with dates only takes the property defaults.
  `parseIcsCalendar` reads a local DATE-TIME's times but does not store them yet. The Google Sheet sync still owns guest names and
  non-channel rows; its stays take defaults and get no guest texts.

Coverage: `tests/unit/booking-exact-times.test.tsx`, `bookings-half-day.test.tsx`, `stay-add-ons.test.ts`,
`stripe-webhook-stay-add-on.test.ts`, `resident-stay-add-ons-route.test.ts`, `stay-time-reminders.test.ts`,
`arrival-guide.test.ts`, `turnover-cleaning-window.test.ts`, `schedule-records-guest-login-pinned.test.ts`.

## Status is derived from the dates, never stored

`bookingStatusLabel` (`booking-presentation.ts`) is the label a row or record
prints — **Hold · Confirmed · In-house · Checked out · Cancelled**, plus
**Blocked** for a live block with nobody attached (§ Blocks) — and
`calendarStatus` (`bookings-calendar-view.ts`) the one a calendar cell colours,
which says the same **Blocked** and names the channel for an imported stay. Both
derive from the entry's own dates against today: an approved applicant (a `hold`
entry) is never a pending hold — **In-house** once their dates have started,
**Confirmed** before them, and neither needs an `applicationId`, so a
calendar-only teammate reads the same word. **Hold** is left for a native block
still waiting to be confirmed. A list row prints that
same word (`bookingStatusLabel` again) — a closed room reads **Blocked** on the row
too, because the row's Source fact renders for channel imports only and so
cannot tell a closed room from a guest's pending Hold. The label is a plain fact on a
row, never a pill (AGENTS.md § Portal UI system) — and Confirmed says nothing at
all, because it is the default.

The day pop-up's row *title* is a third, separate thing: `dayStayDisplayName`
(`occupancy/snapshot.ts`) names the guest, and only the manager's own block on a
room reads plain **Blocked**. A channel's own "Not available" names its channel —
"Airbnb · Not available", "Other calendar · Not available" through the one
`bookingSourceLabel` resolver — because the manager did not make it and cannot
edit it here. Either kind of dates-only row (the manager's own block, a channel's
"Not available") is what `isAvailabilityBlockRow` marks: it takes the padlock
tile and is offered no Message, because there is nobody to message. A channel
"Reserved" is a real guest stay, never an availability block.

Occupancy figures on Calendar (`calendarOccupancySummary`) count every resident
stay — In-house or still Confirmed (`isResidentStay`) — and exclude only an
unconfirmed hold, without touching capacity arbitration, and read through
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
Add/Edit sheet). The record's actions are header icons only — no ⋯ (§ Blocks);
a list row keeps its own. An imported stay's Edit is the exception: it opens the
notes-and-money popup (§ Airbnb money), never the Add/Edit sheet.

## Blocks: Unblock and Delete (Oct 14 2026)

**Unblock = cancel (undoable, frees nights everywhere); Delete = hard delete, native blocks only; imported bars are tombstoned, never deleted.**
`bookingRemovalActions` (`booking-presentation.ts`) is the one gate the calendar bar's popover and the record page's header read: a live native block (source `block`, has `blockId`, not cancelled, not ended) offers Unblock (`BookingsCancelDialog`, with Undo) and Delete (`BookingsDeleteBlockDialog`, a danger confirm, then `deleteRoomDateBlock`); a cancelled or ended native block offers Delete only; an imported Airbnb / Booking.com bar offers "Unblock in PropLane" on the bar and "Remove from PropLane" on the record (`BookingsRemoveStayDialog`, a restorable tombstone) and no Delete; a resident stay (lease, application) offers neither. The record header is icon actions only (Message, Edit, Unblock, Delete, Open resident, plus **Open in Airbnb** on an imported Airbnb reservation whose code the sync could parse — `airbnbOpenUrlForEntry`, `reservation-code.ts`, which rebuilds the link from the code and never from the feed's own URL; the Guest card's Reservation row prints the bare code and carries no link of its own); there is no ⋯ menu. A live block with nobody attached reads **Blocked** (`bookingStatusLabel`), **Cancelled** only after Unblock; a list row says the same Blocked (§ Status). No new route: the server refuses cancelling an ended block (409) but lets a cancelled or ended block be deleted, and ownership stays `managerCanWriteCalendarForProperty`. All three are also hidden from a teammate below Calendar `edit` on that house, and while the session is still resolving — `canRemoveBookingEntry` (`manager-portfolio-access.ts`) is the client's read of the same grant the server enforces, so nothing is offered that the write would refuse (coverage: `tests/unit/bookings-removal-permission.test.tsx`). A `room_date_block` row whose `row_data.bookingStatus` is `cancelled` is read as cancelled by the client (`normalizeBlock`) and the occupancy snapshot, as the export feed and capacity already did. Coverage: `tests/unit/bookings-block-actions.test.tsx`.

Bookings' own removal surfaces go through ONE router (`deleteOrCancel`): the list row, the Add/Edit sheet's footer (`onDelete`), the day pop-up's row and the Add/Edit sheet's own hold list (`onRemoveBooking`) all hand it the whole entry and all gate on `canRemoveBooking` first, so `bookingCancelLabel` always names what actually happens, none of them hard-deletes a named hold, and none removes anything without a confirm. The one exception is Quick book from an application, which renders no removal dialogs: it still passes the legacy `onDeleteBlock` (delete by id, no confirm) and is deliberately left as it was. The router itself: a marked reservation (a block with nobody attached) goes to `BookingsDeleteBlockDialog` and is deleted outright at any date, a past one included (`canDeleteReservation`, a hard delete through `deleteRoomDateBlock`, and there is no Undo — that delete cannot be reversed), and a block held for a named person goes to `BookingsCancelDialog` and is cancelled until its last night (`canCancelBooking`, soft cancel, undoable). The bar popover's Unblock / Delete (above) are the calendar's doors to the same dialogs, so the popover has no second delete entry. The popover is non-modal (`DropdownMenu modal={false}`, `backdrop={false}`) so opening a dialog from it never inherits a body pointer lock.

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
- A booking typed in PropLane itself raises its own `booking_created` / `booking_cancelled`, and EVERY
  booking also emails the workspace owner whatever their alert destination says — § Every booking has a
  name, and the owner is emailed for every booking.

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

A listing that allows short stays is ONE price card, on every width — phone included — with a **Monthly | Short stay** segment control. The segment appears only when the listing really can be booked: `offered` in `short-stay-booking.tsx` is the one predicate (short stays on, at least one room to hold, a nightly rate), so the card never prints "— / night" and a roomless listing keeps the Monthly side alone. Short stay draws the Airbnb-style block (`ShortStayBookingBlock`) inside that card: check-in / check-out, Room, Guests, a live "$X × N nights" total, **Request to book** (**Quick book** for a signed-in resident with saved answers) and a plain "Text <work number>" link. The card owns the one price line — `from $X / night` above the segments — so the block never prints a price header of its own. Dates narrow the rooms list through `shortStayRoomVerdict` (`src/lib/short-stay-request.ts`; check-out exclusive, anonymous occupancy spans only): taken rooms stay listed, dimmed, with "Booked <range> · free from <date>". **Request to book** posts to `POST /api/public/short-stay-request` (`src/lib/short-stay-request.server.ts`), which re-checks availability server-side (409 when taken, including the capacity trigger's refusal), then saves the same `room_date_block` hold the manager's Add booking sheet saves (guest on the block, `rate` = nightly with `rateBasis: "daily"`, quoted nights and total beside it), texts the guest from the work number, emails them when an address was given, and emits `channel_booking` / `short_stay_requested` to the owner and teammates. Nothing is charged at request time. The guest is given a resident login keyed on the phone they typed (§ Guest portal stays), the hold expires after 24 hours, and the manager answers with Approve / Decline in Bookings. Abuse guard: 10 requests a minute per IP, a hidden honeypot, check-in within 180 days, 1 to 28 nights. Coverage: `tests/unit/short-stay-request-lib.test.ts`, `tests/unit/short-stay-request-route.test.ts`, `tests/unit/short-stay-booking-card.test.tsx`.

## Guest portal stays (Oct 14 2026)

A guest who has stayed once books again from their own portal: **Stays** at `/resident/stays/{upcoming|past}`, the Book again sheet, and the signed-in route behind them. The public card's "Request to book" above is the first-time door; this is the return.

- **One core writes every stay row.** `createShortStayRows` (`src/lib/short-stay-request.server.ts`) is the only writer of a short-stay `room_date_block`. The public route (`submitShortStayRequest`, which keeps its own per-IP / per-phone / per-property limits) and `POST /api/resident/stays` (`src/lib/short-stay/guest-stays.server.ts`) both call it, so a row has one shape: `stayDetails.guests` (the capacity trigger weighs a stay by it and never reads the top-level `guests`, so a four-guest request on a shared room used to count as one), `stayDetails.source` (`public_short_stay_request` | `guest_portal`), `residentUserId`, and on a hold `stayDetails.holdExpiresAt` 24 hours out. Each date range is its own stay with its own outcome (`confirmed` | `pending` | `unavailable` | `invalid`); one range refused never stops the others, and the capacity trigger stays the final arbiter (409 on that range alone). A taken night is refused, never held: holds count against capacity.
- **Identity is the session.** The route reads the profile's name, mobile and login address; nothing in a body names the guest. `authorizeResidentRole` guards it. The sheet's server dry run (`dryRun: true`) runs every real check and writes nothing, and its answer is the primary button's wording: "Confirm stay", "Request to book", or "Confirm and request" (`guestBookAction`).
- **Instant confirm for returning guests** (`short-stay/instant-book.server.ts`): a range is written `confirmed` when the listing's `shortStayInstantBookReturning` (Short stay card checkbox "Returning guests book instantly", absent reads ON, saved on the submission and never resolved downstream) is on, the guest has at least one COMPLETED confirmed stay on the listing, and the host never declined one of their requests there. A past stay counts as theirs by login id, by login address, or by a phone that `profiles.phone_verified_at` proves is theirs - never by a number just typed into Settings, which would buy a stranger's standing. Anyone else gets a 24-hour hold. A failed history read is "not returning" (a hold, never a surprise confirm).
- **Payment.** A confirmed stay raises one `stay_total` charge through `upsertManagerCharges` (the financials write-through, `short-stay/stay-charge.server.ts`). The id derives from the block id (`hc_mgr_stay_<block>_stay_total`), so Approve twice or an instant confirm never writes a second one or overwrites a paid one. The `hc_mgr_` prefix keeps it past the manager Payments reconciler. It carries `guestStayBlockId`, never `shortStayBookingId`: that field is what the Stripe webhook reads to settle a legacy pay-to-hold booking and would mint a lease and an application on payment. Both resident keys name the guest's own LOGIN - `residentUserId` and the address that account signs in with, read from `profiles`. The typed email is never one of them: Payments finds a charge by `resident_user_id` OR `resident_email`, so an unverified address would raise a payable charge in the Payments of whoever really owns it. A stay with no login raises nothing and logs `no_guest`.
- **The host answers** (`short-stay/hold-decisions.server.ts`, `POST /api/portal/bookings/short-stay-decision`, Approve / Decline `PortalIconAction`s on the hold in `bookings-edit-sheet.tsx`). Approve -> `confirmed` + the charge; Decline -> `cancelled_room_date_block` with `stayDetails.decision: "declined"` (ends instant booking for that guest on that listing); the `short-stay-hold-expiry` cron (every 5 minutes) cancels a hold past `holdExpiresAt` with `decision: "expired"` (not held against the guest). One compare-and-swap on the stored status settles a double click or an Approve racing the cron. The caller must own the house or hold Calendar `edit` on it, re-derived from the stored block. Each outcome texts the guest from the workspace work number (email from the work email, never to a placeholder address) and emits `channel_booking` / `short_stay_confirmed|declined|expired` (domain and category `tours` are already admitted by both `action_events` checks, so no constraint was widened: `tests/unit/short-stay-guest-events.test.ts`). A manager's booking-editor save carries `residentUserId`, `stayDetails.guests`, `holdExpiresAt` and `decision` forward from the stored row, and PINS `stayDetails.source` (`carryGuestStayFields`, the schedule-records route's `reconcileExisting`, for a platform admin's save too); never strip them. The source is what marks the row as a request: overwriting it with "Direct" hid Approve / Decline, made `decideShortStayHold` refuse the row as already answered, and left the cron to cancel the nights as an unpaid hold without telling the guest - so the editor's Source menu reads rather than sets it on a pending request.
- **A guest with no login** (the public card) gets one: `short-stay/guest-login.server.ts` signs them into the account the typed PHONE provably owns - the placeholder it minted for that number (`guest.<digits>@import.proplane.local`, found by that stable login address so a returning guest keeps it even once a real resident stores the same digits) or an account whose `profiles.phone` is VERIFIED - and otherwise mints that placeholder, with the `resident` role and `emailProven: false`. The confirmation text names the sign-in PAGE ("Sign in at <origin>/auth/sign-in to see your stays", `withGuestSignInPrompt`), never a live one-time link: that text leaves from the host's line and is STORED IN THE HOST'S OUTBOX, where the host could read and use it. `ensureGuestLogin` still mints a one-time `token_hash` link (`/auth/confirm?...&type=magiclink`, never a PKCE `code`) when a caller opts in with `mintLink: true` AND `smsProvenSessionAllowed` says a text alone may open that account ([`one-number.md`](one-number.md) § W5); no caller asks today. Neither typed field is an identity: an email because anyone could name a victim's address and read every row keyed on it (it stays on the stay row for the host's copy alone), and a bare phone match because `profiles.phone` is self-edited in Settings - a recycled, reassigned, mistyped or shared number would otherwise be texted a link into that resident's lease, payments and documents. Same rule as the instant-book history match above. Because the account is provably the phone's, the hold is stamped with it (`residentUserId`), which is what `/resident/stays` and the `stay_total` charge read. Two accounts claiming one VERIFIED number, or a refusal from the account service, means no login and no link - the stay is still saved. A manager who shares the number is never given the role.
- **Nav.** `stays` is a registered, rendered section (`resident-sections.ts`, `render-portal-section.tsx`, `RESIDENT_RENDERED_SECTION_IDS`), open at EVERY stage (`STAGE_UNLOCKED_SECTIONS` is built by `withStageIndependentSections`, so a stage cannot forget it) but drawn, and its URL allowed, only when the login owns a stay row (`ResidentPortalAccessState.hasStays`; one indexed read, migration `20261014090000_guest_stays_resident_index.sql`). A guest with only stays is the `short_stay_guest` stage: bottom bar Stays, Payments, Messages (+ More), and a sign-in lands on `/resident/stays`. The home demo never lists the row (`withoutConditionalResidentSections`).
- **By text** (Oct 19, `on/smsstay`): a texter on the PropLane line (or a workspace's own number) books through `quote_short_stays` -> `prepare_short_stay` -> `request_short_stay` (`src/lib/tools/domains/short-stay-sms.ts`). The options live in `sms_stay_offers` (service role) and the YES books ONLY the stored option picked in an EARLIER turn (`pickIsFromEarlierTurn`) and affirmed by a YES that REPEATS THE 4-DIGIT CODE from the confirmation question (`confirmStayRequestCode` mints the only proof `bookStayForTexter` accepts, and nothing - no login, no hold, no pay link - happens without it, because caller ID is not an identity; `one-number.md` § Coded confirmation on the PropLane line owns the code rules, incl. three wrong codes cancelling the offer); the model supplies no room, date or price. The write is `bookStayForTexter` -> `bookGuestStays({ via: "sms" })` -> `createShortStayRows`, so the row is stamped `stayDetails.source: "sms_short_stay"` (a request source: Approve / Decline apply), bound to the login the texting PHONE provably owns (`ensureGuestLogin`), and the price is re-derived from the live listing (a changed rate is a new quote). Instant-confirm for a returning guest and the 24-hour hold are the unchanged guest-stay rules, and the line's holds are capped whoever is texting: 3 per room per day, 6 per workspace per hour (`SMS_STAY_HOLDS_PER_LISTING_PER_DAY` / `SMS_STAY_HOLDS_PER_WORKSPACE_PER_HOUR`), so a stranger cannot fill a calendar or flood a host. The reply to the texter is the only text sent from the booking (`via: "sms"` skips `textGuest`); the team hears `channel_booking` / `short_stay_requested` ("Short-stay request by text") and later `short_stay_confirmed|declined|expired` like any request. Catalog: PropLane-managed `is_service` homes on the PropLane line (`loadShortStayHomes`), the workspace's own live homes on its own number; only a listing that offers short stays with a real nightly rate is ever quoted. Coverage: `sms-stay-intent.test.ts`, `sms-stay-booking.test.ts`.
- **Paying a stay** (`short-stay/stay-pay-link.server.ts`): a confirmed stay's `stay_total` is paid from a phone-bound `/l/<token>` (purpose `rent`, target that charge) texted to the guest's phone: in the instant-confirm reply and in the host's approval text (`guestStayApprovedText`). The page asks for a code texted to the same phone, then opens the card / Apple Pay / Google Pay form in the page (Stripe embedded checkout) or "Pay from bank"; no sign-in, no app, no other site. The pay link is texted, never emailed. "Send me the payment link" (`send_payment_link`, `tools/domains/payment-link-sms.ts`) re-sends it for a stay and for the open deposit / first-month / fee charges of an approved application, to the login the phone provably owns.
- **Unpaid after confirmation** (`short-stay/unpaid-expiry.server.ts`, run by the `short-stay-hold-expiry` cron): a guest-request stay confirmed more than 24 hours ago (`SHORT_STAY_PAY_HOURS`) whose `stay_total` is still `pending` / `failed` and whose check-in is ahead is cancelled (`decision: "unpaid_expired"`, compare-and-swap, shown to the guest as Expired), the charge cancelled, the pay link ended, the guest texted and the team told (`short_stay_unpaid_expired`). Paid, clearing, part-paid, charge-less and manager-typed stays are never touched.
- **Not built here:** Withdraw request, Message host and Add a night from a row's ⋯; the saved application and the Apply sheet (the plan's "Apply once, anywhere" phase).

Coverage: `tests/unit/short-stay-instant-book.test.ts`, `short-stay-guests-weight.test.ts`, `short-stay-hold-decisions.test.ts`, `short-stay-guest-login.test.ts`, `short-stay-public-guest-login.test.ts`, `short-stay-guest-events.test.ts`, `resident-stays-route.test.ts`, `short-stay-decision-route.test.ts`, `guest-stays-lib.test.ts`, `resident-stage-tables-agree.test.ts`, `resident-stays-ui.test.tsx`, `bookings-short-stay-decision.test.tsx`.

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

## Every booking has a name, and the owner is emailed for every booking

- A `room_date_block` is a named reservation (`residentName`) or a room the manager CLOSED:
  `blockKind: "closed"` plus a non-empty `reason`. One validator, `roomDateBlockNameError`
  (`room-block-name-rule.ts`), is shared by the Add/Edit sheets, `saveRoomDateBlock`, the
  `/api/portal-schedule-records` route (400) and the `block_room_dates` / `update_room_block` tools.
  A cancelled block and a delete are never refused; rows saved before the field existed still render.
  A reason of "Airbnb" or "Booking" is the import marker and is never a valid Closed reason.
- Every booking (channel stay from a sync, or a native one: created, cancelled, deleted) emails the
  workspace owner's login address from the work email, whatever their alert destination says
  (`sendOwnerBookingEmail` in `channel-booking-events.server.ts`). It is idempotent on the bus
  notice's own key `action-event:<eventId>:manager`, so a repeat sync, or a manager whose destination
  is email, gets one mail. Native events are `booking_created` / `booking_cancelled` (event id
  `native:<blockId>:<event>`); a closed room is not a booking and announces nothing. Giving a closed
  room or an unnamed block a guest's name IS a new booking and announces one (the event id makes a
  second announcement of the same block a no-op). A guest's confirmed short stay gets the same owner
  mail, raised once from `emitShortStayTeamNotice`'s `short_stay_confirmed`, which covers both the
  instant confirm and the host's Approve. The guest a channel event names is `bookingEntryGuestLabel`
  over the feed range — the same label the sync files the reservation's resident under ("Airbnb guest ·
  HM…" when the code is all the feed gave), never a bare "Booked (Airbnb)" the Bookings list disagrees with.
- The listing room editor's "Blocked dates" list is manager-closed rooms only: a named booking and
  an imported channel stay share the `hold` status, so it filters them out (`managerBlocksForRoom`) -
  saving one from that list would re-file it as a Closed room and drop the guest's name, email and phone.
- The name rule arbitrates NEW content only: a save that leaves the stored row's name, kind and
  reason exactly as they are passes (`roomBlockNameShapeUnchanged`, the one definition behind the
  route's `sameRoomBlockNameShape`, the `update_room_block` tool and the Edit sheet), so putting
  back what was just cancelled, and editing the dates of a row written before the rule existed,
  always work. The Edit sheet keeps the stored `blockKind` on an untouched label for that reason —
  stamping `closed` onto a pure date edit is new content the route would then refuse.
- One reservation draws ONCE in the calendar grid and in the Bookings list: both read
  `calendarEntries` (`withoutChannelStaysCoveredByResidents`), which drops the channel bar a synced
  Airbnb resident stands in for. `entries` stays whole for the record page, the day page, "Open in
  Airbnb", payouts and the export feed.
- A sync never writes over a name a person put on an Airbnb resident. `channel_stay_details.guest_name`
  wins; failing that a stored name the sync did not invent (anything but "Airbnb guest · HM…" or a
  generic feed summary) is kept, so a rename in Residents survives the next sync.
