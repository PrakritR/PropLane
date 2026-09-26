> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Sandbox accounts & the /demo mirror (one config, every environment)

**`/demo` is a real, standalone public page again** (`src/app/demo/page.tsx`,
deliberately outside the `(public)` route group so it renders with no
marketing nav/footer). The home page's Codex-style hero
(`src/components/marketing/site/hero.tsx`, `site/codex-hero-window.tsx`)
also embeds that exact same page live, in a real `<iframe src="/demo">`
opening on the manager Dashboard — an iframe is a separate browsing context,
so a click inside it can never navigate the marketing page away. Both entry
points run the identical component and the identical one-way, no-writes
rules below; nothing about them differs by route.

**The manager view is built from the REAL portal shell** (`demo-manager-
shell.tsx`), not a redrawn stand-in: the actual `PortalSidebar`,
`PortalTopBar`, `PortalMobileNavBar`, and the real `AssistantDockPanel`
(pointed at `/api/agent/demo-chat` instead of the auth-gated
`/api/agent/chat`), each fed the demo data layer — `usePortalSession()`
already resolves a synthetic `demo-manager` scope id under any `/demo` path,
and `WorkspaceProvider` now has a demo branch (`GET /api/demo/workspace`,
public and read-only, never a caller-supplied id) since the real
`GET /api/workspaces` requires a session and would 401 a signed-out visitor.
There is no role switcher, no "Run demo" walkthrough, and no separate
floating chat bubble — manager only, matching the real `/portal` (captain
2026-09-25). `PortalAssistantDockRail`'s own `dockable`/`isDemoModeActive()`
gate is intentionally skipped for this one page (see that file's docstring)
rather than loosened anywhere shared.

**The portfolio is real, not fictional.** `buildDemoIdleSnapshot()` (below)
now returns "Seattle Homes" — three properties, one leased resident, one
pending application, one upcoming tour — written onto the canonical
`manager@test.proplane.local` account by `scripts/seed-demo-manager-
portfolio.ts` (dev/test only; see that script's header for the production
caveat). Because that account is also a shared QA fixture other panes seed
other properties onto, both `demo-portal-mirror.server.ts` and
`GET /api/demo/workspace` filter every property-scoped row down to exactly
those three property ids — `/demo` always shows the curated portfolio, never
whatever else has accumulated on the account.

`next.config.ts`'s `/demo/:path+` redirect and `src/middleware.ts`
still bounce an unknown deeper sub-path (there is no `/demo/[section]` route)
to plain `/demo`, never to `/`.

**`/demo` renders from ONE bundled, deterministic dataset in code — a fully
synthetic "Seattle Homes" account (manager, residents, a vendor — ids in the
`demo-*` namespace) — never a live mirror of any real account's rows, and
never writes anywhere (captain 2026-09-25).** `buildDemoIdleSnapshot()` in
`src/lib/demo/demo-guided-data.ts` returns that populated "Seattle Homes"
portfolio (three properties — Alder House, Maple Duplex, Fremont Studio —
residents, a pending application, an upcoming tour, a scheduled work order with
an accepted Pacific Plumbing bid, a manager inbox thread), so every portal
panel it feeds shows real numbers on first paint instead of "nothing here
yet." `/demo` renders from browser-local stores re-seeded on every mount
(`seedDemoPortalIdleData()`), so demo edits live in sessionStorage and are
wiped by refresh.

**The DB mirror is retired, not paused.** `DEMO_PORTAL_MIRROR_ENABLED`
(`src/lib/demo/demo-mirror-flag.ts`) is permanently `false` — do not flip it
back on; a future decision to show live account data in `/demo` again is a new
decision, not a revert of this one. `GET /api/demo/portal-snapshot` still
exists (both mirror readers always resolve `null`) so it always answers with
the same bundled static snapshot regardless of what any `@test.proplane.local`
account's real rows look like in whatever environment the deploy points at.

There is deliberately no PORTFOLIO invented for a real account: the seeded
"Seattle Homes" data lives entirely in `buildDemoIdleSnapshot()`'s code, keyed
to the synthetic `demo-*` scope ids, never written onto a real
`@test.proplane.local` row. The former `src/lib/demo/demo-data.ts` (Ava Nguyen,
The Pioneer, Cascade Lofts, …) was deleted for a related but distinct reason —
a second, hand-maintained fixture drifting from the product — which is why
`buildDemoIdleSnapshot()` stays the single seam: it also feeds the sandboxed
agent context (`demo-agent-context.ts`) and the canonical-portfolio DB seed
(`scripts/seed-demo-manager-portfolio.ts`, dev/test only), so one edit here
keeps all three in sync. Every server-mirror write path stays
`isDemoModeActive()`-gated defensively; the work-orders panel's direct fetches
(approve-pay / complete / auto-schedule / bid-accept / vendor email) got
explicit demo short-circuits — a signed-in user browsing `/demo` must never
write real rows, and must never have their OWN real account data fetched
either (`useManagerMessagingNumberStatus()`, `fetchManagerReachabilityForWelcome()`,
and several tour/lease reads learned this the hard way — each called a real,
auth-gated route unconditionally until audited). Keep that gate pattern for any
new panel action or read that hits an authed route.

**`/demo?role=&section=&tab=` deep-links into one exact record**, read on the
server (`src/app/demo/page.tsx`) so the initial render is already correct. The
home page's five lifecycle rows (`site/lifecycle-rows.tsx`) and the audience
mocks (`site/demo-route-slice.tsx`) both deep-link this way — e.g.
`?role=resident&section=lease&tab=demo-lease-demo-prop-alder` opens that one
lease's own sign/record view, not just the bare section list. A section or tab
combination that isn't wired in `demo-section-renderer.tsx` renders "Nothing to
show yet." rather than erroring — treat that as a missing case to add, the way
manager `tours` and resident `lease`'s `?tab=` were until this pass.

**The guided "Run demo" tour builds its own data from a blank slate.**
`prepareDemoSegment` (`src/lib/demo/demo-segment-prep.ts`) seeds
`buildDemoBlankSnapshot()` for every segment and then lists a property through
the real pipeline; `overall` creates one through the listing wizard itself. This
is why `DEMO_SEGMENT_OPTIONS` (`demo-segments.ts`) — not `DEMO_SEGMENT_LABELS` —
drives the picker: only the self-building segments are offered. `communication`
and `payments` narrate operations on rows that must already exist (an unread
thread, an outstanding charge), so with an empty sandbox they would play out over
blank screens; their step defs and playback scripts are kept intact, just
unlisted. Anything the autoplay types in (`demo-listing-autofill.ts`,
`demo-application-autofill.ts`) stays an obvious placeholder — "Demo Property",
"Sample Employer" — never an invented person, employer, or address that could be
mistaken for a real record.

Both tour endings (natural finish and the Exit button) land on the same state:
the guided scope flips back to the idle scope and the idle snapshot is
re-seeded, so panels never read stale guided-scope rows. Display names for the
canonical resident/vendor are the neutral "Test Resident"/"Test Vendor"
(`demo-canonical-accounts.ts` — the seed `tests/helpers/seed-test-db.mjs`
duplicates them as plain literals; keep in sync).

**Provisioning is per-environment, one implementation.** The portfolio writer
lives in `src/lib/demo/canonical-demo-portfolio-db.ts`, shared by the test-DB
seed CLI (`tests/helpers/seed-canonical-demo-portfolio.ts`, spawned from
`seed-test-db.mjs`) and the admin-gated `POST /api/admin/provision-sandbox-
accounts` (accounts + roles + pro tier + portfolio; `{"seedPortfolio":false}`
for accounts only; idempotent, never deletes). Dev/test: `npm run test:seed`
(also PRUNES non-canonical accounts — including any personal Gmail — by
design, except the captain dogfood keep-list in
`tests/helpers/canonical-test-accounts.mjs`: `akhil-manager@prop-lane.space`,
`akhil-resident@prop-lane.space`, and that portfolio's residents). The seed
recreates that pair via `scripts/seed-akhil-dev-accounts.mjs`. A nuclear wipe
is never automatic (not CI, not a hook) and must not run unless a human asked. Production: run the route once as the production admin after deploy;
credentials never leave the environment. `admin@test.proplane.local` is deliberately
NOT provisioned by the route — never auto-create an admin-role account with a
well-known password in production. Signups always land in whatever DB the
deployment's env points at (`assertNonProdDatabase` guards the cross-wiring).
In-app account deletion (`POST /api/account/delete`, all portals) refuses
`@test.proplane.local` accounts — deleting one would brick `/demo` and the tour.
