# Tours, availability & slot math

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Approval-first automated tours

When a manager opts in (`proposeTourConfirmations`, default OFF, on
`manager_automation_settings`), a new pending tour inquiry generates a PROPOSAL
to confirm it into the first matching open slot. It NEVER auto-books or emails —
the proposal is a gated pending action the manager approves. Invariants:

- **One booking core.** `confirmTourInquiry` (`src/lib/tour-inquiry-confirm.server.ts`)
  is the single implementation behind both the manual accept route and the
  auto-tour tool — `resolveConfirmedEnd`, plannedEvent creation, competing-inquiry
  removal, `notifyTenantTourConfirmed`. Never duplicate booking logic; the tool
  path passes `guardDoubleBook: true` (refuse a slot a confirmed tour occupies),
  the manual route leaves it off to keep its override behavior.
- **Reuses the confirm gate.** The proposal is an `agent_pending_actions` row
  (`confirm_tour_inquiry` write tool in `agentRegistry`) with a 7-day expiry;
  approve/discard go through `runConfirmedPendingAction`/`denyPendingAction`
  (`src/lib/tools/confirm-gate.server.ts`) — the SAME gate the assistant uses.
  Standalone surface: `GET/POST /api/portal-tour-inquiries/proposals` +
  `TourProposalsPanel` on the manager calendar.
- **First-open-slot math** (`src/lib/tour-proposal.server.ts`, `tour-slot-math.ts`)
  mirrors the public availability route's exclusion set; it excludes the
  inquiry's own window so it never blocks itself. No slot match → no proposal.

## A slotKey is WALL TIME, and the wall clock is Pacific — never the server's

`"2026-08-06:20"` means "10:00 on Aug 6" on the calendar a manager paints and a
guest reads. Resolving it with `new Date(y, m, d)` reads the SERVER's zone —
Pacific in dev, **UTC on Vercel** — and every consequence is a silent no-op, not
an error: `overlaps()` compares a confirmed tour against the wrong half hour so
the booked slot stays on offer and a second prospect books on top of it, and
`slotIsBookable()` mis-judges which slots are past. Both shipped. `slotStartMs` /
`blockInstantMs` in `src/lib/tour-slot-math.ts` are the anchor
(`TOUR_CALENDAR_TIME_ZONE`); use them rather than constructing Dates from a
slotKey. A Pacific dev box cannot see this class of bug, so
`tests/unit/tour-slot-math-timezone.test.ts` pins the process to UTC.

Known, deliberately not widened: the PUBLIC booking client still turns the chosen
slot into an instant with the PROSPECT's browser zone, so an out-of-region guest
sends a slotKey and an ISO that disagree. Blocking survives it because a planned
tour carries its `slotKey` and `slotBlocked` matches that first.

## What a prospect is offered = published − busy − booked

The one rule behind `/api/public/property-tour-availability`:

    offered = (published availability, or the 9-5 default when none is
               published) MINUS calendar-busy MINUS already-booked

- **The 9-5 default is intended**, not a bug — a property whose manager has not
  opened a calendar still offers a day (`buildDefaultTourSlotKeys`), and the same
  subtraction applies to it. The trigger is ONE named predicate,
  `shouldOfferDefaultTourGrid(publishedFutureSlots)` in `tour-slot-math.ts`: the
  default fires whenever no FUTURE slot is published, so a painted week that has
  simply passed yields a default rather than a dead booking page. Its doc comment
  states the accepted sharp edge (a manager who clears their ENTIRE calendar has
  it silently reopened) and how to switch to the stricter "never published
  anything" rule in one line. The horizon is `DEFAULT_TOUR_HORIZON_DAYS = 21` —
  the response is `no-store`, so every request pays for the whole grid. It fires
  only for a **`live`** property, and so does everything else: the direct-id
  lookup deliberately resolves a record of any status, so
  `PUBLICLY_BOOKABLE_PROPERTY_STATUS` gates `matchingPropertyRecords` itself and
  a non-live property returns an empty grid before any availability is read.
  Gating only the default branch is not enough — `manager_availability` rows are
  GLOBAL to the manager, so a draft/pending/review/unlisted listing would still
  hand its manager's real portfolio calendar to anyone holding its id.
- **Already-booked** is pending inquiries AND confirmed planned tours; a
  reschedule drops the stale `slotKey` so the old window is not still blocked.
- **Calendar-busy** is the manager's linked Google Calendar, cached per manager
  in-process because this route is public and uncached — and only reused for a
  window the cached read actually COVERS, since busy time is subtracted across
  the whole range of slots the response offers, not just the default horizon
  (`googleBusyWindowEndMs`). What counts as busy is `googleEventBlocksTours`
  (`google-calendar/busy.ts`) — declined never blocks, all-day always does
  (Google defaults all-day entries to Free), Free does not. The MANAGER's
  calendar runs the SAME predicate, but as a tag rather than a filter:
  `googleCalendarEventsToMeetings` draws every Google event and carries
  `blocksTourAvailability`, which only the "N open" math reads — so a declined or
  Free event stays visible on the grid without the headers disagreeing with what
  a prospect is offered.
- **The route is IP rate-limited** (`rateLimit`, 60/min) because it is public,
  unauthenticated and uncached, and each request fans out one Google read per
  host manager — a read that can also refresh and write back that manager's
  OAuth token. The in-process busy cache is a per-instance throttle only, so it
  is not a substitute; do not drop the limiter to "restore" throughput.
- **The response is `no-store` on purpose**, against the repo's prefer-caching
  rule: `s-maxage=300` meant a just-booked slot stayed on offer for minutes. A
  double-booked tour costs more than the egress.

Cancel/reschedule of a CONFIRMED tour go through
`src/lib/tour-planned-change.server.ts` (routes `/api/portal-tour-inquiries/
{cancel,reschedule}`) because the guest must be reached — PropLane already
emailed them "your tour is confirmed". A client-side store rewrite reaches
nobody. Those routes write server-side, so the caller must
`syncScheduleRecordsFromServer({ force: true })` afterwards or the grid and the
view-tab counts keep showing the pre-change tour until a manual reload.
