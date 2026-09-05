# Database environments

Axis uses **three Supabase projects** and keeps their schemas identical with the
Supabase CLI. Which project you touch is decided entirely by which env file is
loaded — the app code never switches databases by itself.

## The three projects

| Environment | Used by | Supabase project | Credentials come from |
|---|---|---|---|
| **Dev + Test** | local `npm run dev`, `vitest`, Playwright, Vercel `main` Preview | `emstjswhotsnyksqhqyf` | `.env` (local dev) and `.env.test` (tests); Vercel Preview (default) |
| **Staging** | Vercel `staging` Preview (dedicated QA) | `xwszcafaontidfgznlxd` | Vercel Preview env vars **restricted to git branch `staging`**. Local copy: `.env.staging.local` (gitignored). Dashboard: https://supabase.com/dashboard/project/xwszcafaontidfgznlxd |
| **Production** | the live site (`prop-lane.space`) | `qahnczmilgptcedaqype` | **Vercel Production env vars only** |

`staging` is a third project in the PrakritR org, schema-matched from the repo
migrations. It is **not** the live production database. `assertNonProdDatabase()`
still refuses the live production project on the `staging` git branch.

A full **data** copy from production (auth users, tenant rows, storage) is a
separate captain-owned dump/restore. Schema is applied. Production listing
restore migrations (Brooklyn / 4709A) were skipped on purpose. Do not write
those live rows back to production from staging.

The default Preview `NEXT_PUBLIC_SUPABASE_URL` record is shared with Production
and currently still names the live project. Do not copy that default onto
`staging`. Staging's branch-scoped URL/anon/service keys point at
`xwszcafaontidfgznlxd`.

### Staging custom domain (Namecheap → Vercel)

After the captain buys the hostname:

1. Tell the agent the exact domain (example: `proplane-staging.com`).
2. `vercel domains add <domain> axis-2` and assign it to git branch `staging`.
3. At Namecheap, either:
   - Point nameservers to Vercel (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`), or
   - Keep Namecheap DNS and add a CNAME for `@` or `www` to `cname.vercel-dns.com`.
4. Set staging Auth Site URL + redirect allowlist on project `xwszcafaontidfgznlxd`
   to `https://<domain>`.
5. Add Preview/`staging` `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_CANONICAL_APP_URL`
   for that hostname.

Until that domain exists, QA uses the Vercel Preview URL for the `staging` branch.

Rules:

- **Local development and the automated tests share the dev/test project.** Tests
  namespace their rows by `testRunId` and clean them up
  (`tests/helpers/seed-test-db.mjs` / `cleanup-test-db.mjs`), so they coexist
  with manual dev data.
- **Production credentials never live in a local file.** They are set in the
  Vercel Production scope only. A local `.env` must point at the dev/test
  project.
- **Staging credentials live only in `.env.staging.local` and the Vercel
  `staging` git-branch scope.** Agents do not write the live production project.
- **Wipes are never automatic.** CI, git hooks, and `npm test` / `test:unit`
  do not run `wipe:test:all`, `wipe:dev`, or the portal purges. Those scripts
  require an explicit env flag (`ALLOW_DEV_WIPE=1` or `CONFIRM_PURGE=yes`) and
  a human request. `npm run test:seed` does prune accounts that are not on the
  keep-list in `tests/helpers/canonical-test-accounts.mjs`; the captain
  dogfood pair (`akhil-manager@prop-lane.space` /
  `akhil-resident@prop-lane.space`) is on that list and is recreated by the
  seed. Do not wipe the shared project to get a clean E2E fixture.

### A local production build can silently target production

The rule above ("which env file is loaded decides the project") has one trap: a
correct `.env` is **not** enough for a production build. Next loads
`.env.production.local` for `npm run build`, that file outranks `.env`, and
`NEXT_PUBLIC_*` values are inlined into the bundle at build time — so
`npm run build && npm run start` serves a site whose browser client talks to
production no matter what `.env` / `.env.test` say. Worktrees are especially
exposed: `npm run seed:env` copies every gitignored `.env*` file from the
primary checkout, so a `.env.production.local` pulled earlier for the production
demo seed (below) follows you into each new worktree.

The symptom is quiet and misleading — seeded `@test.…local` accounts get
"Invalid login credentials", which reads as a broken seed rather than the wrong
project. (`assertNonProdDatabase()` does not catch it: the browser client is not
server-side, so nothing throws.)

Confirm which project a build actually points at, and pin dev/test when building
for local E2E (CI does the same by passing `TEST_SUPABASE_*` into the e2e step):

```bash
grep -rho 'https://[a-z]\{20\}\.supabase\.co' .next/static | sort -u
set -a; . ./.env.test; set +a           # then build + start in that same shell
```

### Fail-closed guard

`assertNonProdDatabase()` in `src/lib/server-env.ts` throws if a non-production
runtime (local dev, tests, Vercel preview, or the `staging` git branch) has
`NEXT_PUBLIC_SUPABASE_URL` pointing at the production project. It is wired into every server-side path that
opens a connection: the anon SSR client (`src/lib/supabase/server.ts`, reads),
the service-role client (`src/lib/supabase/service.ts`, privileged writes), the
password-verify helper (`src/lib/auth/verify-auth-password.ts`), and the OAuth
callback route (`src/app/auth/callback/route.ts`, which performs a real auth
exchange). So a misconfigured local env fails loudly instead of silently
touching production. The browser client cannot run this server-only check but
has no elevated access. `src/middleware.ts` is intentionally not guarded: it
only does a cookie-based `getSession` with no network round-trip, and importing
the `server-only` module into the middleware bundle is avoided.

> **The guard protects the app runtime only — not the Supabase CLI.** `db:push`,
> `db:pull`, and `db:baseline` act on whichever project is currently linked. A
> `supabase link` to production followed by `db:push` (or a hand-run `supabase db
> reset`) would mutate production. Always confirm the linked project (keep
> dev/test linked by default) before any push.

The production project ref is supplied out-of-band via the optional
`AXIS_PROD_SUPABASE_REF` env var (so the ref is not hardcoded in source). Set it
to `qahnczmilgptcedaqype` in your local `.env`/`.env.test` and in Vercel. When
unset the guard is a no-op.

## Local setup

1. Copy `.env.example` → `.env` (or `.env.local`) and fill the Supabase block
   with the **dev/test** project values (`Project Settings → API` of
   `emstjswhotsnyksqhqyf`). Set `AXIS_PROD_SUPABASE_REF=qahnczmilgptcedaqype`.
2. `.env.test` already targets the dev/test project — leave it.
3. Run `npm run dev`. Create an account; the row lands in the dev/test project,
   never in production.

## Schema workflow (Supabase CLI)

The files in `supabase/migrations/` are the versioned schema history. Apply
the same migrations to both projects so they stay identical.

One-time login + link to the dev/test project (the default working DB):

```bash
supabase login                 # opens browser, stores an access token
npm run db:link:dev            # links emstjswhotsnyksqhqyf (prompts for DB password)
```

Day-to-day:

```bash
npm run db:new add_some_table  # create a new timestamped migration file
# ...edit the generated SQL...
npm run db:diff                # show schema drift vs the linked (dev/test) project
npm run db:push                # apply pending migrations to dev/test
# run the app + tests against dev/test
```

### Baseline / mirror the dev/test project from production

Both projects were originally built from the same migration files, so they
already share a schema — what they lack is the CLI **migration-history** table
that lets `db push` / `db diff` track state. Adopt the existing schema as the
baseline (non-destructive — nothing is dropped or re-run):

```bash
# 1. Confirm production matches the repo history (should add no migration)
supabase link --project-ref qahnczmilgptcedaqype
npm run db:pull                 # if it writes a migration, that is prod drift — commit it
npm run db:baseline            # mark all current migrations as applied on prod
npm run db:status              # every migration shows applied

# 2. Do the same on dev/test, then keep it linked as the default
npm run db:link:dev
npm run db:baseline
npm run db:status

# 3. (optional, needs Docker) prove there is no schema drift on dev/test
npm run db:diff                # expect: "No schema changes found"
```

> **`npm run db:reset` does not exist, by design.** `supabase db reset --linked`
> fails on managed Supabase — its teardown truncates `auth.*` / `storage.*`
> objects that the `postgres` role does not own (e.g.
> `auth.refresh_tokens_id_seq`), so it aborts with `must be owner of sequence …`.
> Reset is only for the local Docker DB. To adopt an already-applied schema use
> `db:baseline` (above). `db:diff` requires Docker to build its shadow database.

### Deploying a schema change to production

Migrations are pushed to production deliberately, as a separate step:

```bash
supabase link --project-ref qahnczmilgptcedaqype   # link production
npm run db:diff                                     # confirm what will change
npm run db:push                                     # apply to production
npm run db:link:dev                                 # ALWAYS relink back to dev/test
```

Because the same migration files are pushed to both projects, the schemas stay
mirrored.

### Migration versions are apply-time, not filenames

Supabase records a migration under the timestamp at which it was **applied**, so
a repo file named `20260721210000_…` can be recorded remotely as
`20260722023635`. Two standing consequences:

- A new migration's filename must sort after the *recorded* remote head (`npm
  run db:status` reads it) or `db push` refuses the whole batch.
- Because names and recorded versions drift apart, migrations get replayed by
  `db push --include-all`. **Write every migration idempotently** — `drop policy
  if exists` before `create policy`, `create table if not exists`, and so on.

#### Release note: `--include-all` required for the vendor-invoice RLS migration

A worked example of the rule above, on production (project
`qahnczmilgptcedaqype`). At this deploy the production migration head was
`20260721200505` — repo `20260721130000_claw_thread_topic_services.sql`,
recorded under its apply time — so the pending local migrations `20260721140000`
and `20260721141000` sort **before** it. Plain `supabase db push` (`npm run
db:push`) therefore refuses them as out-of-order; push this release with
`supabase db push --include-all` instead (both migrations are idempotent, so
`--include-all` is safe). Do not fix this by re-timestamping repo files.

> Note: `supabase db push/diff/baseline` act on whichever project is currently
> **linked**. Keep dev/test linked by default; only link production for a
> deliberate deploy, and relink to dev/test immediately after.

## Production demo seed (live site only)

> **Prefer a separate demo Supabase project** for the public `/demo` sandbox — see
> [Demo Supabase project](#demo-supabase-project) below. The production seed below
> is legacy: it writes `@axis.local` accounts into the **production** database.

The public `/demo` route uses client-side localStorage by default — it never writes
to Supabase. To exercise **real** signed-in portals on the production deployment
(manager / resident / vendor), run the one-shot CLI seed against the production
project:

```bash
# Pull production creds locally (never commit the pulled file)
vercel env pull .env.production.local --environment=production

# Set AXIS_PRODUCTION_SEED_KEY + AXIS_PROD_DEMO_PASSWORD in Vercel Production
ALLOW_PRODUCTION_SEED=1 AXIS_PROD_DEMO_PASSWORD='your-demo-password' \
  node --env-file=.env.production.local scripts/seed-production-portal.mjs
# or: ALLOW_PRODUCTION_SEED=1 AXIS_PROD_DEMO_PASSWORD='…' npm run seed:production -- --env-file=.env.production.local
```

Guards (fail closed):

- `assertProductionProjectUrl` — URL must be the production project ref
- `assertProductionSeedGate` — requires `ALLOW_PRODUCTION_SEED=1` and
  `AXIS_PRODUCTION_SEED_KEY` (server-only; set in Vercel Production scope only)
- Test seeds (`test:seed`, `seed-demo-manager-workflow.mjs`) refuse the
  production project via `assertTestProjectUrl`; production seed refuses
  dev/test via `assertProductionProjectUrl`

Demo accounts use `@axis.local` emails (no outbound email). Sign in on the live
site after seeding:

| Role | Email |
|---|---|
| Manager | `alex.morgan@axis.local` |
| Resident | `jordan.lee@axis.local` |
| Vendor | `cascade.mechanical@axis.local` |

Password: value of `AXIS_PROD_DEMO_PASSWORD`. Re-run the seed anytime to refresh
relative dates and upsert rows — it only touches the demo manager scope plus
those three accounts.

## Demo Supabase project

The public `/demo` sandbox can use a **third** Supabase project, isolated from
production and dev/test. Set these in Vercel **Production** scope:

| Variable | Scope | Purpose |
|---|---|---|
| `NEXT_PUBLIC_DEMO_SUPABASE_URL` | Public | Demo project API URL |
| `NEXT_PUBLIC_DEMO_SUPABASE_ANON_KEY` | Public | Demo project anon key |
| `DEMO_SUPABASE_URL` | Server | Same URL (server-side reads) |
| `DEMO_SUPABASE_SERVICE_ROLE_KEY` | Server | Demo project service role |
| `AXIS_DEMO_SEED_PASSWORD` | Server | Password for `@axis.local` demo accounts |
| `DEMO_SUPABASE_PROJECT_REF` | Server | Demo project ref; required by `wipe-dev-supabase.mjs --demo`'s allowlist guard |

When the demo env vars are unset, `/demo` falls back to browser localStorage seed
data (no network). `/demo` nav and the landing-page demo CTA are enabled on
production by default; set `NEXT_PUBLIC_AXIS_PUBLIC_DEMO_ENABLED=false` to hide them.

Seed the demo project (never production):

```bash
# Apply the same migrations to the demo project first (supabase link + db:push)
ALLOW_DEMO_SEED=1 AXIS_DEMO_SEED_PASSWORD='your-demo-password' \
  node --env-file=.env.local scripts/seed-demo-supabase.mjs
# or: ALLOW_DEMO_SEED=1 AXIS_DEMO_SEED_PASSWORD='…' npm run seed:demo
```

Guards:

- `assertDemoSupabaseIsolated` (runtime) — server paths refuse a demo URL that
  equals `NEXT_PUBLIC_SUPABASE_URL`
- `assertDemoSeedGate` — requires `ALLOW_DEMO_SEED=1`

`scripts/wipe-dev-supabase.mjs --demo` (see below) uses a separate allowlist
guard, `assertAllowlistedDemoProjectUrl`, gated on `DEMO_SUPABASE_PROJECT_REF`.

Demo accounts (same `@axis.local` emails as the local sandbox):

| Role | Email |
|---|---|
| Manager | `alex.morgan@axis.local` |
| Resident | `jordan.lee@axis.local` |
| Vendor | `cascade.mechanical@axis.local` |

Password: value of `AXIS_DEMO_SEED_PASSWORD`.

## A note on MCP

There is no Supabase MCP server configured in this repo (only a Neon MCP). The
Supabase CLI is the source of truth for schema sync. A Supabase MCP could be
added later for convenience, but it would still rely on these migrations.
