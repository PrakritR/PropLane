# Axis Test Suite

## Quick start

```bash
cp .env.test.example .env.test
# Fill in dedicated Supabase test project credentials

npm run test:unit          # Fast pure-logic tests (no external deps)
npm run test:integration   # API route tests (needs .env.test or mocked)
npm run test:e2e           # Playwright browser tests (needs .env.test + running app)
npm run test:e2e:smoke     # Bounded main-branch browser gate (9 cases + auth preflight)
npm run test:all           # All Vitest + Playwright
```

## Cursor + Chrome DevTools MCP (agent browser walks)

For ship-gate **manual feature testing**, agents can attach to live Chrome via the
**Chrome DevTools MCP** (screenshots, console, network) instead of only running
Playwright headless. Setup, macOS permissions, and example prompts:
[`docs/cursor-chrome-devtools-mcp.md`](../docs/cursor-chrome-devtools-mcp.md).

The server is declared in [`.cursor/mcp.json`](../.cursor/mcp.json) as
`chrome-devtools`. Enable it under **Cursor Settings → MCP** after pull.

## Cursor + Linear MCP (issues & project context)

To let agents read or create Linear issues from Cursor, enable the `linear` server
in [`.cursor/mcp.json`](../.cursor/mcp.json). Setup and OAuth/API-key options:
[`docs/cursor-linear-mcp.md`](../docs/cursor-linear-mcp.md).

## Environment

Use a **dedicated Supabase test project** — never production credentials. See [`.env.test.example`](../.env.test.example).

For manager E2E signup, set `PROPLANE_PAYMENT_WAIVER_CODE=FREE100` to skip Stripe checkout.

For manager/resident/admin portal E2E tests, run `npm run test:seed` then set `E2E_TESTS_ENABLED=1` in `.env.test`.

Use the smoke command or an explicit spec list during local development. The
full suite contains 158 tests and intentionally runs with one worker; it belongs
in the scheduled/manual CI job unless a change genuinely spans the whole app.
For repeated local browser runs, build/start once and set
`PLAYWRIGHT_SKIP_WEBSERVER=1` rather than using `next dev`, whose cold route
compilation can dominate time and memory on a constrained machine.

> **`E2E_TESTS_ENABLED=1` is a promise that the portal accounts are reachable.**
> The portal specs sign in as seeded accounts before asserting anything, so with
> the flag on but the accounts unseeded (or the `E2E_*` credentials wrong) every
> spec stalls on `waitForURL`. Playwright's `globalSetup`
> (`tests/global-setup.ts`) does one real sign-in per seeded role (admin,
> manager, resident) first and fails the run in seconds with an actionable
> message instead of letting all 158 cases grind for the whole `globalTimeout`.
> Only turn the flag on where the accounts actually exist.

## Multi-role accounts & the portal chooser

One login can hold several portal roles (a shipped feature). For a multi-role
account, `effectiveRole` is derived **only** from the `axis_active_portal` cookie
(`src/lib/auth/portal-access.ts`), and sign-in does **not** set that cookie — so
every direct navigation to `/portal/*` (etc.) bounces to `/auth/choose-portal`
(`portal-layout-guard.ts`). The `signInAs*` helpers therefore call
`establishActivePortal` (`tests/helpers/auth.ts`), which drives the chooser to
pin the cookie; do the same in any new signed-in spec rather than asserting the
account is single-role. The seed marks `manager@` `onlyRole: true`, but it can
still acquire a `resident` role by applying from its own portal — that is
legitimate, and the helpers handle it.

> **Neither browser CI job (`e2e`, `e2e-full`) runs `test:seed`.** They sign in
> as whatever the shared test project currently holds, so account state
> (including the roles above) persists between runs. If a role goes missing or an
> account's state drifts, re-run `npm run test:seed`. Adding a seed step to those
> workflow jobs is a sensible follow-up.

## GitHub Actions secrets

Configure these in your repository settings for CI:

| Secret | Purpose |
|--------|---------|
| `TEST_SUPABASE_URL` | Test project URL |
| `TEST_SUPABASE_ANON_KEY` | Test anon key |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | Test service role key |
| `TEST_AXIS_ADMIN_REGISTER_KEY` | Admin bootstrap key |
| `TEST_PROPLANE_PAYMENT_WAIVER_CODE` (or legacy `TEST_AXIS_PAYMENT_WAIVER_CODE`) | `FREE100` |
| `STRIPE_SECRET_KEY` | Stripe test mode key |
| `STRIPE_WEBHOOK_SECRET` | Stripe test webhook secret |
| `CRON_SECRET` | Cron route auth |

Both browser jobs set `E2E_TESTS_ENABLED=1`, so they also need the portal
credentials below **and** the matching accounts seeded into the test project — the
`globalSetup` preflight fails the job fast if they are absent. That holds for the
`e2e` smoke job too: its 9 cases are public flows, but the preflight still signs
in as all three roles before any of them run:

| Secret | Purpose |
|--------|---------|
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | Admin portal sign-in |
| `E2E_MANAGER_EMAIL` / `E2E_MANAGER_PASSWORD` | Manager portal sign-in |
| `E2E_RESIDENT_EMAIL` / `E2E_RESIDENT_PASSWORD` | Resident portal sign-in |

## Seed / cleanup

```bash
npm run test:seed
npm run test:cleanup -- <testRunId>
```

### The seed does not delete other people's accounts by default

`npm run test:seed` / `npm run seed:dev` used to prune every non-canonical
account it found — which, on the shared dev project, meant deleting accounts
other lanes were actively using, including two outside the test namespace
entirely. The teammate then saw "Invalid login credentials" and reasonably read
it as a product bug.

Now: the prune only ever considers `@test.proplane.local` (plus auth artifacts
with no email at all), it prints what it left alone, and outside CI it **reports
instead of deleting** unless you ask:

```bash
npm run seed:dev                       # seeds; lists strays, deletes nothing
npm run seed:dev -- --prune            # seeds and deletes them
SEED_PRUNE_STRAYS=1 npm run seed:dev   # same, for a script
```

CI still prunes automatically — a disposable database is what the original
model was right about.

### Canonical demo portal accounts (`@test.proplane.local`)

`npm run test:seed` provisions the sandbox accounts below **and** writes the dev/test catalog it needs: **20 live listings** on `manager@` (five canonical demo homes plus fifteen `mgr-scale-*` portfolio rows) and the browse catalog on `manager2@`. Every approved catalog applicant gets a **lease pipeline row**, **household charges**, and (when fully signed) a **recurring rent profile**. The primary E2E resident (`resident@`) is seeded as an approved applicant on **Lakeview Studio** with a **signed lease** and payable charges. Default **promotion flyer + listing blurb** rows are seeded for each live `manager@` property. The primary manager is seeded as **Business** tier (`manager_purchases.tier = business`, 20-property cap). The **shared** portfolio seed (`src/lib/demo/canonical-demo-portfolio-db.ts`, the one production provisioning runs) is what adds **no portfolio rows** — it sources `buildDemoIdleSnapshot()` (`src/lib/demo/demo-guided-data.ts`), which ships empty on purpose, since there is no static fictional dataset any more (`src/lib/demo/demo-data.ts` was deleted). See [`docs/agents/demo-sandbox.md`](../docs/agents/demo-sandbox.md) for the two-source model and the mirror switch, and `AGENTS.md` → "Property ownership" for why those five ids are reclaimed to `manager@` before any other seed cleanup step.

The canonical values live in **`tests/fixtures/qa-accounts.mjs`** — one source
for the docs, the specs, the seed script and the `scripts/qa-*.mjs` audits.
`npm run test:accounts:check` reports whether each one currently exists, is
confirmed, carries its role and can actually sign in; it resolves the same
`E2E_*` overrides, so a `.env.test` pointing somewhere else shows up there
rather than as a mystery failure three layers down.

| Role | Email | Password (default) |
|------|-------|---------------------|
| Admin | `admin@test.proplane.local` | `TestAdmin123!` |
| Manager (demo portfolio, Business, 20 listings) | `manager@test.proplane.local` | `TestManager123!` |
| Manager (browse catalog) | `manager2@test.proplane.local` | `TestManager123!` |
| Resident | `resident@test.proplane.local` | `TestResident123!` |
| Vendor | `vendor@test.proplane.local` | `TestVendor123!` |
| All portals | `testeverything@test.proplane.local` | `TestEverything123!` |
| Captain dogfood manager | `akhil-manager@prop-lane.space` | `Password123!` |
| Captain dogfood resident | `akhil-resident@prop-lane.space` | `Password123!` |

**Workflow applicant residents** (manager@test portfolio — applications, leases, charges at varied pipeline stages):

| Pattern | Password | Example |
|---------|----------|---------|
| `{first}.{last}.workflow@test.proplane.local` | `123Password$` | `marcus.chen.workflow@test.proplane.local` |

**Browse-catalog applicant residents** (manager2@test properties):

| Pattern | Password | Example |
|---------|----------|---------|
| `{first}.{last}.e2e@test.proplane.local` | `123Password$` | `maya.chen.e2e@test.proplane.local` |

- **`resident@test`** — primary E2E account: approved application on **Lakeview Studio**, **signed lease**, move-in charges (deposit/first month paid), current **rent** charge pending.

- **Signed-in portal** (`/portal`, `/resident`, `/vendor`) reads and writes these rows in the test Supabase project.
- **`/demo`** loads the same data read-only via `/api/demo/portal-snapshot` (changes in demo stay in the browser; a refresh re-seeds from the mirror; portal edits persist to the DB and show up in demo — never the reverse). That mirror is currently switched OFF at `DEMO_PORTAL_MIRROR_ENABLED` (`src/lib/demo/demo-mirror-flag.ts`), so `/demo` renders empty states regardless of what these accounts hold.
- **`testeverything@`** holds every role (sign-in shows the portal picker) and was the guided "Run demo" tour's data source (`/api/demo/portal-snapshot?scope=guided`); with the mirror off the tour always starts from a blank slate and builds its own data.
- Local `.env` should point at the **same test Supabase project** as `.env.test` so the demo mirror works on `localhost`.
- Re-run `npm run test:seed` after schema changes or when demo portfolio data drifts.
- Production gets the same accounts (minus `admin@` and `manager2@`) via the admin-gated `POST /api/admin/provision-sandbox-accounts` — same shared implementation (`src/lib/demo/canonical-demo-portfolio-db.ts`), run once per environment.

Browse-catalog E2E properties live on `manager2@test.proplane.local` so they do not collide with the demo manager portfolio.
