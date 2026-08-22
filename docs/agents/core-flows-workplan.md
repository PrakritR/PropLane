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

- **Payments** — the captain wants this parked. **Lock the section on BOTH the manager and
  resident side** so nobody lands in a half-built flow. Use `portalNavLockKind`
  (`src/lib/portals/nav-locks.ts`); resident locks are `inert`, and a locked row must never be a
  live link to a path the server then bounces (see AGENTS.md "Portal nav locks"). Payment
  *reminders* are part of this deferral.
- **Bookings** — remove the tab. It appears in the calendar segmented control
  (Tours / Service orders / Bookings).
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

1. **`POST /api/auth/link-tour-inquiry` returns 400 immediately after a booking.** The booking
   still succeeds and the tour still shows in the resident's Tour tab, so the visible flow is
   fine — but the call fails silently (`.catch(() => false)` in
   `src/lib/tour-resident-link.client.ts`). Find out what the link is meant to guarantee before
   patching it; it is on a booking path.
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

## Suggested order

Tours (closest to done) -> Applications -> Leases -> Communication -> Services -> Properties tabs.
Lock Payments and remove Bookings early: both are small, and they shrink the surface everything
else has to be tested against.
