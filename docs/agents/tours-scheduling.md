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

The one rule, and now literally one function — `listOpenTourSlots`
(`src/lib/tour-availability.server.ts`):

    offered = (published availability, or the 9-5 default when none is
               published) MINUS calendar-busy MINUS already-booked

`GET /api/public/property-tour-availability` is a thin caller of it, and so is
every tour tool (`list_open_tour_slots`, and the re-checks inside `request_tour`
and `book_tour`). That is the point: **nothing may offer a slot the public grid
would not.** It used to live inline in the route, which meant an agent had only
`loadManagerTourBlocks` (`tour-proposal.server.ts`) to compute from — and that
one only mirrors this exclusion set by hand and omits Google-busy entirely, so
it would have handed out times the manager's calendar says they are busy for.
Folding the approval-first proposal flow onto `listOpenTourSlots` too would
remove the last place two definitions of "open" can drift.

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
  (`google-calendar/busy.ts`) — declined never blocks, informational types
  (`birthday`, `workingLocation`) never block, Free ("transparent") does not,
  out-of-office/focus-time always do. The MANAGER calendar runs the SAME
  predicate, but as a tag rather than a filter: `googleCalendarEventsToMeetings`
  carries `blocksTourAvailability`, which only the "N open" math reads. Free and
  declined private Google rows still draw on the grid (labelled "Free") without
  the headers disagreeing with what a prospect is offered; informational metadata
  rows do not draw at all.
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
view-tab counts keep showing the pre-change tour until a manual reload. Both
routes accept an optional `subject` + `messageBody` so the manager can replace
the default notification copy; unset falls back to the builders in
`tour-notifications.ts`.

A PENDING request is moved with a different route:
`POST /api/portal-tour-inquiries/propose-reschedule` rewrites the requested
window and emails the guest a *proposal* to confirm
(`buildTourRescheduleConfirmRequestBody`) — nothing is booked, and the inquiry
stays `pending`. It refuses anything that is not a pending `tour` the caller
owns, and refuses with 409 when `previousStart`/`previousEnd` no longer match the
stored window, so two managers editing the same request cannot silently overwrite
each other.

**A manager can also book a tour with no inquiry behind it.**
`POST /api/portal/manual-tour` → `createManualPlannedTour`
(`manual-planned-tour.server.ts`) writes a planned event directly for a walk-in
or phone booking. It authorizes the property through
`getShareablePropertyForUser` / direct ownership / admin / an accepted co-manager
assignment, refuses a slot an active planned tour already occupies, validates the
assignee with `canAssign`, and syncs to Google Calendar. This is the one booking
path that is NOT the proposal gate above — it is the manager entering something
that already happened offline, so there is nobody to propose to. The demo branch
(`manual-planned-tour.client.ts`) writes locally and never calls the route.

## Filing a tour request: `createTourInquiry`

`src/lib/tour-inquiry-create.server.ts` is the ONE way a tour request is
created. `POST /api/public/partner-inquiries` (the website form) and the agent's
`request_tour` both call it, so the contact validation, the host and
published-slot guards (`managerMayHostPropertyTour`, `managerHasPublishedSlot`,
`adminHasPublishedSlot`), the double-book check, the consent opt-in, the manager
and guest notifications, and the approval-first `proposeTourConfirmation` cannot
differ by entry point.

**A caller naming a manager and a time is a request, never an authorization.**
`hostUserId` arrives from the model on the agent path; everything that decides
access is re-derived from the database inside the function.

It never books. A request is `status: "pending"` until a human confirms it.

## Tour tools, and who may do what

| Tool | Registries | What it does |
| --- | --- | --- |
| `list_open_tour_slots` | manager, resident, leasing SMS | The offered set, above. The only source of a time any other tool may accept. |
| `request_tour` | resident, leasing SMS | Files a pending inquiry via `createTourInquiry`. Books nothing. |
| `book_tour` | manager | `createManualPlannedTour` — a booking from scratch, no inquiry needed. |
| `confirm_tour_inquiry` | manager | Accepts an existing request (this is what the approval-first proposal targets). |
| `reschedule_tour` / `cancel_tour` | manager | `tour-planned-change.server.ts`; both email the guest. |

- **The agent never invents a time.** Every write takes `start`/`end` copied
  verbatim from `list_open_tour_slots`, and re-checks the slot is still on offer
  in the HANDLER as well as the preview — a slot open when a proposal was written
  can be taken before anyone confirms it. `book_tour` additionally requires the
  slot's host to be the acting landlord.
- **`request_tour` is inline allow-listed on the leasing SMS surface**
  (`LEASING_SMS_INLINE_WRITE_TOOLS`), the second entry ever after
  `escalate_to_manager`. A texting prospect is anonymous, so there is no
  `user_id` a pending action could be claimed on: a confirmation card is
  impossible, not merely absent. It is safe inline because it is the same risk
  class as an escalation — it files a request and notifies the manager, and books
  nothing.
- **`create_calendar_event` does not block a tour slot unless you say so.** Only
  a `kind: "tour"` planned event subtracts from availability; every other kind is
  ignored by `loadManagerTourBlocks` and `listOpenTourSlots` alike. That made the
  tool a trap — a manager blocking their morning with it stayed bookable from the
  public page — so it takes `blocksTours` (default false, since an ordinary
  meeting should not silently close a booking window) and stamps `kind: "tour"`
  when set. Use `book_tour` for an actual tour with a guest.
- **Still missing: `decline_tour_inquiry`.** Its logic is inline in
  `/api/portal-tour-inquiries/delete` and needs the same extraction the two
  functions above got. Tracked in
  [`docs/agents/agent-capability-backlog.md`](agent-capability-backlog.md).

Coverage: `tests/unit/tools/tours.test.ts`, `tests/unit/tools/calendar-tools.test.ts`.
