> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Sandbox accounts & the /demo mirror (one config, every environment)

**`/demo` is read-only against real data, and when it does read it the flow is
strictly one-way: signed-in portal edits → DB → `/demo`. Never the reverse.**
`/demo` renders from browser-local stores re-seeded on every mount, so demo edits
live in sessionStorage and are wiped by refresh. The seed comes from
`GET /api/demo/portal-snapshot` (service-role read of `manager@`/`resident@`/
`vendor@test.proplane.local`, ids remapped to synthetic `demo-*` scopes, per-empty-
collection static fallback) **only while the mirror is enabled — it is currently
off**, so today every mount seeds the static snapshot instead; see the two
sources below. Every server-mirror write path is `isDemoModeActive()`-gated; the
work-orders panel's direct fetches (approve-pay / complete / auto-schedule /
bid-accept / vendor email) got explicit demo short-circuits — a signed-in user
browsing `/demo` must never write real rows. Keep that gate pattern for any new
panel action that fetches an authed route.

**The static demo dataset ships EMPTY, on purpose — and it is only one of TWO
data sources.** A visitor sees whichever of these wins:

1. **The DB mirror** — `GET /api/demo/portal-snapshot`, the canonical
   `@test.proplane.local` accounts' real portal rows. Wins whenever those accounts
   hold data, in whatever environment the deploy points at — while it is
   enabled, which it currently is not (see below).
2. **The static snapshot** — `buildDemoIdleSnapshot()` in
   `src/lib/demo/demo-guided-data.ts`, the fallback when the mirror is empty or
   unreachable. It returns `emptySnapshot()`, so `/demo` renders the real portal
   panels in their normal "nothing here yet" empty states for all three roles.

There is deliberately no fictional portfolio in code: a made-up applicant or
building on a public sandbox reads as a real record to a visitor, and invented
data drifts from the product as the portals change. The former
`src/lib/demo/demo-data.ts` (Ava Nguyen, The Pioneer, Cascade Lofts, …) was
deleted for exactly that reason. **To give the demo a portfolio, put real data on
the canonical accounts and let the mirror carry it** — do not re-add a static
fixture. `buildDemoIdleSnapshot()` is the single seam if a curated baseline is
ever wanted again; it also feeds the sandboxed agent context
(`demo-agent-context.ts`) and the canonical-portfolio DB seed, so filling it in
lights up all three at once.

Because the mirror is a separate source, **emptying the code does not empty a
deployed `/demo`** — rows already sitting on the canonical accounts keep being
served, and purging those rows is a live-DB operation, separate from any code
change. So the mirror is currently switched OFF at
`DEMO_PORTAL_MIRROR_ENABLED` (`src/lib/demo/demo-mirror-flag.ts`), which forces
source 2 everywhere and guarantees a clean sandbox in every environment without
touching a database. Both the server route (`fetchDemoPortalMirrorSnapshot` /
`fetchDemoGuidedMirrorSnapshot` return `null`) and the client seeder
(`seedDemoPortalDataFromMirror` / `seedDemoGuidedBaseData` skip the fetch) read
that one constant. **It is meant to be turned back on** once the leftover
fictional rows are purged — the mirror code underneath is untouched. Flip the
constant; do not delete the mirror.

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
