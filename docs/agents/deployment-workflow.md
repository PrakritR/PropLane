# Deployment workflow (all agents)

**`production` deploys the live site; `staging` is QA by default; `main` is
tested on localhost.** Every agent must follow this ladder. A single
[standing policy](temporary-direct-production-policy.json) permits an
explicit Akhil-authorized `origin/main` → `origin/production` promotion, with
no end date (delete it to revoke). See `AGENTS.md` § Branching & deployment for the
rest of the contract.

## Branch ladder

| Branch | Role | Database | Vercel | CI |
| --- | --- | --- | --- | --- |
| standing keeper | Prakrit's persistent agent sandbox; retain after integration | shared dev/test | No deploy | unit + lint + build; PR only on request |
| **`prakrit`** | Captain integration — folds completed keeper work together | shared dev/test | No deploy | localhost review on :3000 |
| `main` | Consolidation. Developers verify on localhost. | shared dev/test | **No deploy** | unit, lint, build, integration, e2e smoke |
| `staging` | QA candidate. Fast-forward of `main`. | staging project `xwszcafaontidfgznlxd` (never live production) | **Preview** (branch-scoped env) | same as `main` |
| `production` | Live site + TestFlight | live production | **Production** | TestFlight workflow |

`prakrit` is Prakrit's integration branch between agent keepers. The captain
climbs the ladder by typing **`/promote prakrit`** in a lane's pane (or
**`/promote main`** → **`/promote staging`** → **`/promote staging to
production`** to climb further). There is no long-lived `dev` branch; feature
and agent branches are the messy layer.

An explicit Akhil ship request authorizes agents working for him to promote
only his keeper → `main` → `staging` → `production`; it does not authorize
writing `prakrit`. Only the standing Akhil policy above may skip staging;
fast-forward-only promotion and every production safety gate remain.

## Vercel: `proplane` is PropLane production

The live dashboard project is **`proplane`**
(`prj_rupckw3T2v0oXVg2nTLVCYePKDUc`) and serves `proplane.ai`. Legacy hosts
(`prop-lane.space`, `proplane.space`, `axis-seattle-housing.com`, and each
`www.` variant) stay attached to the same Production deployment — **never**
a Vercel domain-level 308 to `proplane.ai`. Do not relink the project or use
a separate branch-created project for live traffic. The generic Preview
environment shares production defaults, so staging deployments must retain
their `staging` branch-scoped variables. `proplane.space` (no hyphen) still
needs to be attached to this project in the Vercel dashboard before it serves
anything.

**Legacy-host redirect lives in application middleware, not Vercel.** A
domain-level 308 can't tell an already-installed Capacitor shell's WebView
(`server.url` can still be a legacy host — `capacitor.config.ts`'s
`allowNavigation`) from a phone's Safari tab; that ambiguity caused the
2026-09-24 permanent black splash. `src/middleware.ts` +
`src/lib/legacy-host-redirect.ts` instead redirect only an actual **browser**
top-level page load on a legacy host (GET/HEAD, `Sec-Fetch-Dest: document` or
`Sec-Fetch-Mode: navigate`) to `https://proplane.ai` + the same path and
query, with a 308. It never redirects `/api/**`, a non-GET/HEAD request, or
any request carrying native evidence — the Capacitor entry path, the
first-party `proplane_native` cookie `NativeBridge` sets on launch, or an
in-app WebView user agent. Everything else (assets, webhooks, cron, native
traffic) keeps being served directly, unredirected, with host-aware
`noindex` — see `docs/mobile-app.md` for the native side of this contract.

**Search indexing:** only `proplane.ai` / `www.proplane.ai` may be crawled.
Staging (`staging-prop-lane.space`), `*.vercel.app` previews, and every other
host serve `Disallow: /` plus `X-Robots-Tag: noindex, nofollow`
(`src/lib/seo/public-crawl-host.ts`). After a domain cutover, clear stale SERP
rows in Google Search Console → Removals for the old hosts (robots alone can
lag for days).

If Production deployments stay on an old commit:

1. **GitHub `Vercel Deploy` may be skipping** - without `VERCEL_TOKEN`,
   `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` repo secrets, only a no-op notice
   runs. Verify those secrets target the existing `proplane` project; do not
   relink the checkout.
2. **Vercel Hobby rejects sub-daily crons** - remove `*/10` schedules from
   `vercel.json` or upgrade to Pro.
3. Use the protected Git branch workflow. The current manual CLI wrappers are
   still pinned to the retired project name and must not be used for this release.

The **Vercel Deploy** workflow permits only `staging` and `production`, including
manual dispatch; `main` retains its CI checks. Staging must use its branch-scoped
variables because generic Preview defaults point at production (see
[database environments](../database-environments.md)).

## Prakrit promote ladder

```
agent branch  →  prakrit (:3000)  →  main  →  staging  →  production
  sandbox:open     /promote prakrit      /promote main → staging → production
  + review path    (captain's word)      (captain's word, each rung)
```

1. Land feature work on your agent / feature branch only.
2. **Before handoff:** `npm run sandbox:open -- </route>` (mandatory for all agents).
3. **Captain** types **`/promote prakrit`** in the lane's pane (runs no-mistakes +
   security review, syncs the lane, merges to prakrit, fans back to all lanes,
   opens prakrit on the review route). `npm run ship:to-prakrit -- --source
   <lane>` is only a thin wrapper around that command's prepare step, kept for
   muscle memory — it never lands prakrit on its own.
4. **Captain** types **`/promote main`** to move prakrit → main (no-mistakes again).
5. For Akhil only, after his explicit ship request, agents working for him may
   land his reviewed keeper directly on `main` without writing `prakrit`. They
   do not run Prakrit's no-mistakes pipeline.
6. **`npm run ship:staging`** then dedicated QA on staging URL by default. An explicit
   Akhil-authorized release omits this rung under the standing policy and
   passes `--skip-staging` to `ship:production`.
7. Apply production Supabase migrations **before** pushing `production`.
8. **`npm run ship:production`** after QA sign-off (live + TestFlight).
9. Confirm Vercel Production **and** iOS TestFlight succeeded.

## Enforcement (do not weaken)

1. **Vercel project** `proplane` (`prj_rupckw3T2v0oXVg2nTLVCYePKDUc`) →
   Production branch = **`production`**.
2. **`vercel.json`** `git.deploymentEnabled`: only `staging` and
   `production` are `true`; `main` and `**` are `false`.
3. **`scripts/vercel-should-build.sh`**: builds only those two refs.
   The GitHub deploy workflow and CLI helper also exclude `main`.
4. **`assertNonProdDatabase()`**: the `staging` git branch may not use the live
   production Supabase project, even if `VERCEL_ENV=production`.
5. **`scripts/promote-main-to-production.sh`**: retired; exits 1.

## Agent rules

- Never push feature branches expecting a Vercel deploy.
- Never merge directly to `production`. Never skip `staging` outside the
  standing Akhil policy.
- Keep `staging` a strict fast-forward of `main`, and `production` a strict
  fast-forward of the script-selected source. Never commit unique work to either.
- Run `npm run ship:preflight` before promoting to production.
- See also `docs/ship-gate.md` and `AGENTS.md` § Branching & deployment.
