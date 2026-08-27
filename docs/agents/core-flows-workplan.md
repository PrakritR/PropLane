# Core flows work plan — get six areas working end to end

Scope agreed with the captain on 2026-08-21. Everything outside this list is explicitly
**deferred**, not forgotten.

## In scope

1. **Tours** — resident books a specific time; confirmation email; reminder email.
2. **Applications** — resident fills and submits.
3. **Leases** — manager can send a lease; resident can sign.
4. **Communication** — manager can message a resident, both directions.
5. **Services** — requests *and* work orders.
6. **Properties** — every tab in the property detail: Details (Preview / House details / Move-in,
   and the Floors / Lease / Amenities / Bundles / Rules / Location strip), Calendar,
   Application, Lease, Requests.

## Explicitly OUT of scope

- **Payments** — parked. **DONE 2026-08-22, both halves:** `DEFERRED_SECTIONS` in
  `src/lib/portals/nav-locks.ts` locks the nav row `inert` for every role and plan, and
  `renderPortalSection` redirects the section away so a typed URL, an old bookmark or an emailed
  link cannot reach it either. The nav lock alone was only the door. The redirect runs BEFORE the
  legacy rewrites, because `stripe` -> `payments` would otherwise land inside a deferred section.
  Guard: `tests/unit/deferred-sections-sealed.test.ts`. Bringing Payments back is deleting one
  entry from that set. Payment *reminders* are part of this deferral.
- ~~**Bookings** — remove the tab.~~ **REVERSED 2026-08-25 by captain request:** Bookings is a
  routed view again on the portfolio Calendar and on a property's Calendar tab. The panels were
  never deleted, only the routing, so restoring it was restoring two constant lists plus the
  `const bookingsView = false` literal. Guard: `tests/unit/calendar-view-tabs-render.test.ts`.
  A property-level **Services** sub-tab is the remaining half of that request and is deliberately
  NOT wired: the services calendar is manager-wide and there is no property-scoped service-visit
  panel, so the tab would render Bookings data under a Services label. Build the panel first.
- **Promotion** — leave exactly as is.

## Environment

- Worktree: `/Users/prakrit/proplane-claude-wt` (isolated; the shared checkout gets reset by other
  agents mid-run, which has cost real work — stay here).
- Dev server: `npm run dev -- -p 3001`. Port 3000 belongs to another agent's worktree; do not kill it.
- Resident test account: `resident@test.proplane.local`. The password is the captain's
  `E2E_RESIDENT_PASSWORD`; ask rather than guessing, and never commit it.
- Manager session: already signed in inside the captain's own Chrome. Drive it with
  `CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1 chrome-devtools-axi ...`. Use the **separate Playwright
  browser** for the resident so the manager session is not clobbered — testing both roles at once
  needs two browsers.

## Verified working (2026-08-21) — do not re-litigate

Driven end to end in a real browser as the resident:

- Listing -> "Schedule a tour" deep-links with the right `propertyId`.
- Room step lists all 9 rooms with correct pricing.
- Date step offers 12 open days; slots run 9:30am-4:30pm, matching the 9-5 default grid.
- Booking submits and lands in the resident Tour tab under **Pending**, host and time correct.
- Approval-first is honoured: it REQUESTS, it does not auto-book.
- All 13 manager sections render with no failed requests and no console errors.

## Known open issues

1. ~~**`POST /api/auth/link-tour-inquiry` returns 400 after a booking.**~~ **RESOLVED 2026-08-22.**
   Not a code bug. The response body was
   `Could not find the table 'public.resident_tour_links' in the schema cache` — the table was
   missing from the **test** project while present in production, i.e. schema drift, not a
   defect. `20260730140000_resident_tour_links.sql` was applied to
   `emstjswhotsnyksqhqyf` (prop-lane test) and the same booking now returns
   `200 {"ok":true}`.

   Two things worth carrying:
   - PostgREST says "not found in the schema cache" for BOTH a missing table and a stale cache.
     Check `to_regclass` before concluding which; the wording does not distinguish them.
   - Production was never affected. Verify a suspected schema bug against BOTH projects before
     calling it a production issue — this one only ever broke local testing.

   Every table the six in-scope flows depend on is confirmed present in test (checked
   2026-08-22): schedule records, tour links, applications, lease pipeline, inbox threads,
   scheduled inbox messages, service requests, work orders, property records, outbound mail,
   notification preferences, scheduled message overrides.
2. **Same-day tours after 5pm.** Not a bug: the default grid is 9-5
   (`DEFAULT_TOUR_START_SLOT` / `DEFAULT_TOUR_END_SLOT_EXCLUSIVE` in `src/lib/tour-slot-math.ts`),
   so an evening visitor only sees tomorrow. If the captain wants evening tours, extend the
   default window — a product decision, not a defect.
3. **No lead-time buffer.** A slot 60 seconds away is bookable, so a manager can get a tour with
   no notice. `slotIsBookable` is the one place to add a minimum notice.
4. **`portal-pinned-footer-overflow` is red on purpose.** Two correct-looking fixes conflict: a
   horizontal scroll hides buttons on web, and `overflow-hidden` clips them on a phone for 4 of
   the 5 `rowVariant="header"` callers. Needs a design decision, not another patch.

## Gotchas that have already cost time here

- **A 404 does not reject a `fetch`.** A wrong API path renders a normal-looking page while the
  work silently never happens — exactly how the Team tab's co-manager purge was dead. The guard is
  `tests/unit/api-fetch-paths-resolve.test.ts`; keep it green.
- **`prakrit` has stopped compiling three times in a week.** Run `npx tsc --noEmit` and
  `npm run build` BEFORE pushing, every time. The CI `build` job catches it, but only after it has
  already landed.
- **Emails need `RESEND_API_KEY`.** Tour confirmation and reminder emails cannot be verified
  without it. Check it is set before reporting email as working, and say so plainly if it is not.
- **Reminder delivery is scheduled, not instant.** See `docs/agents/manual-payment-detection.md`
  for the cron cadence pattern; do not conclude "reminders are broken" from an immediate check.
- **Test both roles for portal gating.** A single-role account passes while multi-role accounts
  break (AGENTS.md, "`profiles.role` is legacy and singular").

## Tours — status 2026-08-22

Verified in a browser, both roles:

- Resident books a specific room + date + time; the request lands in the manager calendar and in
  the resident Tour tab under Pending. Slots honour the 9-5 grid.
- Manager confirms from the calendar; the inquiry becomes a planned event (inquiry payload went
  3 -> 2, planned events present). The confirm itself works.
- `link-tour-inquiry` returns 200 after the test-project migration (see resolved issue 1).

Fixed this pass:

- The plain **Approve** button never told the guest. The route defaults `notifyTenant` to false
  and that call site omitted it, so which control the manager clicked decided whether the
  prospect was ever told their tour was confirmed. Guard:
  `tests/unit/tour-approve-notifies-guest.test.ts`.
- Tour mail to sandbox addresses was posted to Resend for a domain that does not resolve.
  `deliverEmail` hand-rolled a check that knew only `@axis.local`, while the canonical test
  accounts are `@test.proplane.local`. It now uses the shared `shouldSkipOutboundEmail`. Guard:
  `tests/unit/tour-email-skips-sandbox.test.ts`.

**Correction to a previous claim.** An earlier note said the calendar counter did not refresh
after confirming ("3 pending - 0 confirmed"). That reading was taken 8s into a 13.8s cold-compile
request, so it was measured before the write landed. The confirm path does refresh
(`setMeetingRefresh`, `onMeetingsChanged`, `reloadAvailability`). Treat it as unproven rather
than as a known bug, and re-measure on a warm server before chasing it.

**Still not verified: that a confirmation email actually ARRIVES.** Everything up to the send is
now correct, but delivery could not be observed, for a reason worth knowing:

- `notifyTenantTourConfirmed` writes an inbox thread, calls `deliverEmail`, and texts the guest.
  It does NOT write `portal_outbound_mail_records` — that table being empty proves nothing, and
  an earlier read of it was a false signal.
- The test resident is a sandbox address and is now (correctly) skipped, so it can never
  demonstrate delivery. Verifying arrival needs a REAL inbox: book and confirm a tour for an
  address you control, then check `RESEND_FROM` is a verified sender.

**Reminders are a separate mechanism** (`tour-reminder.server.ts`, `/api/portal/tour-reminders`)
and are still entirely untested.

## Applications — status 2026-08-22

Driven as the resident against a real listing. **The wizard is not broken.** It creates an
application, validates each step, and advances correctly:

    Household -> Signer Information -> Property Information -> Employment and Income
      -> References -> Additional Details

- "Apply to property" creates a real record (`PROPLANE-906DB8EF`) and opens at `wizardStep=1`.
- Signer fields pre-fill from the account.
- Every stall was LEGITIMATE validation, not a defect: "Lease term is required",
  "Number of occupants is required", "at least one positive amount in the income section".
  Each cleared as soon as the field was supplied, and the step advanced.

**Submission was not reached, and the reason is tooling, not the product.** The remaining steps
need controls a script cannot drive:

- **Custom dropdowns are not `<select>`.** They are `[data-attr^=select-]` buttons opening
  `[role=option]` lists, and they ignore a programmatic `.click()` — the pick needs real pointer
  events (`pointerdown` + `pointerup`), because every option list picks through
  `useFieldSelectListboxPointerPick` (`src/components/ui/field-select-listbox-pick.ts`).
  Playwright's own `click` works; `element.click()` does not.
- **Screening questions are radio groups**, not checkboxes — a checkbox-only sweep leaves
  Additional Details incomplete with no visible error.
- **ID upload is a file input.** It cannot be set programmatically at all and needs a real
  fixture file.

So the next session should either finish the last two steps by hand in the browser, or write it
as a Playwright e2e spec (which can drive all three control types) rather than a console script.
Do NOT record "applications are broken" — nothing in the flow failed.

## Suggested order

Tours (closest to done) -> Applications -> Leases -> Communication -> Services -> Properties tabs.
Lock Payments and remove Bookings early: both are small, and they shrink the surface everything
else has to be tested against.


## 2026-08-25 — lease accuracy, automation, tour notice

### Lease "random charges" — root cause found and fixed

The reported lease quoted utilities $200, move-in $300 and deposit $800 for a room whose listing
record carried none of those, and whose manager overrides were all empty strings.

The figures were not fabricated by the template — a bare listing correctly renders "—" for every
one of them, verified by rendering it. They belonged to a **different room**.
`resolveSubmissionRoom` is the single decision the lease document AND the charge ledger both price
from, and when the room id does not match it walks a cascade of looser fallbacks. Three could
return the wrong room rather than no room:

- the label pass fell back to a substring compare, and `"room 10".includes("room 1")` is true, so
  the Room 1 resident was priced at Room 10's rent and deposit;
- a substring compare matching several rooms took whichever the array listed first, so the answer
  depended on room ordering;
- a listing with exactly one room handed that room over even when the application named a
  different one — which is what a stale local catalog does after room ids are regenerated.

Fixed so a numeric room name must match on its number, an ambiguous match is refused, and an
application naming an unknown room stops before the shape-based guesses. Returning nothing is the
safe failure: "—" reads as not-set and gets corrected; a confident figure from someone else's room
gets signed. Guard: `tests/unit/listing-room-resolution-wrong-room.test.ts`.

**Short-term pricing was already correct** — a 10-night stay at $50/night renders $50.00 per day,
$500.00 total, deposit $250.00, total due $750.00. The wrong-room resolver was what made nightly
rates look wrong.

**Worth knowing:** only 2 of 10 production `manager_property_records` carry a `submission` at all.
Lease generation reads the manager's browser-side listing catalog, so the server-side record is
usually a thin projection. Anything that tries to generate or re-price a lease server-side has
nothing to read.

### Application → lease automation

Three per-manager switches, all off by default, on
`manager_automation_settings.row_data.applicationAutomation` (no migration — that table always has
a `row_data` JSON column): auto-approve, auto-generate the lease on approval, auto-send it.

`shouldAutomate` is the one decision and every manual-path guard still runs: withdrawn
applications, /demo, already-done steps, and `leaseSendGateBlocker` with its own message. The send
gate is judged on the row AFTER generation — asking it before is asking "may I send this?" of a row
with no document.

**Auto-approve has a switch but no trigger yet.** It needs a decision about when an unattended
approval fires (approval is browser-side, so it would run when the manager's Applications tab
loads). That decision is the captain's, not a plumbing gap.

### Tour notice period

A manager can require N days' notice. `slotIsBookable` takes an optional `noticeDays` defaulting to
0, so existing callers are unchanged. CALENDAR days, not 72 hours — "three days' notice" must mean
the same first day at 9am and at 11pm. The shift is done on the Pacific calendar date, never by
adding 86_400_000ms, because a DST day is 23 or 25 hours; covered across the Nov 1 fall-back.
The public availability route batches one read for all host managers and **fails open** on error:
losing the notice window beats a prospect who cannot book at all.

Guests are now told plainly, in the acknowledgment email and the in-app success banner, that the
tour is NOT confirmed and not to travel to the property until confirmation arrives.

### Still open

- Auto-approve trigger (above).
- Property-level Services calendar sub-tab (needs a property-scoped panel).
- Two long-standing red unit guards, unrelated to this work: `manager-inbox-search`,
  `manager-inbox-resident-scope-selection`.
