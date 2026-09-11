# Deployment workflow (all agents)

**`production` deploys the live site; `staging` is QA by default; `main` is
tested on localhost.** Every agent must follow this ladder. A single
[temporary policy](temporary-direct-production-policy.json) permits an
explicit Akhil-authorized `origin/main` → `origin/production` promotion only
until 2026-09-15T04:00:00Z. See `AGENTS.md` § Branching & deployment for the
rest of the contract.

## Branch ladder

| Branch | Role | Database | Vercel | CI |
| --- | --- | --- | --- | --- |
| `claude-*`, `cursor-*`, feature branches | Per-agent / per-change sandbox | shared dev/test | No deploy | PR: unit + lint + build |
| **`prakrit`** | Captain integration — folds agent keepers together | shared dev/test | No deploy | localhost review on :3000 |
| `main` | Consolidation. Developers verify on localhost. | shared dev/test | **No deploy** | unit, lint, build, integration, e2e smoke |
| `staging` | QA candidate. Fast-forward of `main`. | staging project `xwszcafaontidfgznlxd` (never live production) | **Preview** (branch-scoped env) | same as `main` |
| `production` | Live site + TestFlight | live production | **Production** | TestFlight workflow |

`prakrit` is Prakrit's integration branch between agent keepers. Agents do not
merge there themselves — Prakrit runs `npm run ship:to-prakrit -- --source
<keeper>` (or `/promote prakrit`). There is no long-lived `dev` branch; feature
and agent branches are the messy layer.

An explicit Akhil ship request authorizes agents working for him to promote
only his keeper → `main` → `staging` → `production`; it does not authorize
writing `prakrit`. Only the active dated policy above may waive staging QA;
fast-forward-only promotion and every production safety gate remain.

## Vercel: `proplane` is PropLane production

The live dashboard project is **`proplane`**
(`prj_rupckw3T2v0oXVg2nTLVCYePKDUc`) and serves `prop-lane.space`. Do not relink
it or use a separate branch-created project for live traffic. The generic
Preview environment shares production defaults, so staging deployments must
retain their `staging` branch-scoped variables.

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

## Prakrit ship path

```
agent branch  →  prakrit (:3000)  →  main  →  staging  →  production
  sandbox:open     ship:to-prakrit      (no-mistakes again)
  + review path    + no-mistakes
```

1. Land feature work on your agent / feature branch only.
2. **Before handoff:** `npm run sandbox:open -- </route>` (mandatory for all agents).
3. Captain promotes with **`npm run ship:to-prakrit -- --source <keeper>`**
   (security review + no-mistakes, opens prakrit on the review route).
4. Captain tests on `http://localhost:3000`, then
   `bin/fm-proplane-promote-prakrit-to-main.sh --push-main` (also no-mistakes).
5. For Akhil only, after his explicit ship request, agents working for him may
   use the fast-forward-only integration path to land his reviewed keeper on
   `main`. They do not write `prakrit` or run Prakrit's no-mistakes pipeline.
6. `npm run ship:staging` then dedicated QA on staging URL by default. During
   the dated exception only, an explicit Akhil-authorized release may omit this
   rung and later pass `--skip-staging` to `ship:production`.
7. Apply production Supabase migrations **before** pushing `production`.
8. `npm run ship:production` after QA sign-off (live + TestFlight).
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
  active dated policy.
- Keep `staging` a strict fast-forward of `main`, and `production` a strict
  fast-forward of the script-selected source. Never commit unique work to either.
- Run `npm run ship:preflight` before promoting to production.
- See also `docs/ship-gate.md` and `AGENTS.md` § Branching & deployment.
