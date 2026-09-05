# Deployment workflow (all agents)

**`production` deploys the live site; `staging` is QA; `main` is developer
preview.** Every agent must follow this ladder. See `AGENTS.md` § Branching &
deployment for the contract.

## Branch ladder

| Branch | Role | Database | Vercel | CI |
| --- | --- | --- | --- | --- |
| `claude-*`, `cursor-*`, feature branches | Per-agent / per-change sandbox | shared dev/test | No deploy | PR: unit + lint + build |
| `main` | Consolidation. Developers verify here. | shared dev/test | **Preview** | unit, lint, build, integration, e2e smoke |
| `staging` | QA candidate. Fast-forward of `main`. | staging project `xwszcafaontidfgznlxd` (never live production) | **Preview** (branch-scoped env) | same as `main` |
| `production` | Live site + TestFlight | live production | **Production** | TestFlight workflow |

`prakrit` is retired — do not merge new work into it. There is no long-lived
`dev` branch; feature and agent branches are the messy layer.

## Vercel: `axis-2` is PropLane production

The dashboard project is still named **`axis-2`** — it serves `prop-lane.space`.
Do **not** use the auto-created **`proplane-cursor-branch-1`** project for live
traffic.

If Production deployments stay on an old commit:

1. **GitHub `Vercel Deploy` may be skipping** — without `VERCEL_TOKEN`,
   `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` repo secrets, only a no-op notice
   runs. Add secrets from `.vercel/project.json` after
   `npx vercel link --project axis-2`.
2. **Vercel Hobby rejects sub-daily crons** — remove `*/10` schedules from
   `vercel.json` or upgrade to Pro.
3. **Manual deploy:** `npm run vercel:deploy:production` on the `production`
   branch (see `scripts/vercel-deploy-cli.sh`).

## Ship path

```
agent branch  →  main  →  staging  →  production
     (review)    (dev DB,     (staging DB,   (live + TestFlight)
                  you test)    dedicated QA)
```

1. Land feature work on your agent / feature branch only.
2. Merge to `main` after captain approval; verify on the `main` Preview and
   localhost.
3. **One command for steps 2–3:** `npm run ship:integrate -- --source cursor-1`
   (or `prakrit`) merges `origin/<source>` into `main`, pushes, then
   fast-forwards `staging`. GitHub Action: **Promote** with target `integrate`.
4. Or run separately: `npm run ship:staging` (or **Promote** target `staging`).
5. Dedicated QA tests the staging URL. Staging talks to
   `xwszcafaontidfgznlxd`, never the live production project.
6. Apply production Supabase migrations **before** pushing `production`.
7. Fast-forward `staging` → `production` (`npm run ship:production` or the
   **Promote** Action with target `production`).
8. Confirm Vercel Production **and** iOS TestFlight succeeded.

## Enforcement (do not weaken)

1. **Vercel project** `axis-2` → Production branch = **`production`**.
2. **`vercel.json`** `git.deploymentEnabled`: only `main`, `staging`, and
   `production` are `true`.
3. **`scripts/vercel-should-build.sh`**: builds only those three refs.
4. **`assertNonProdDatabase()`**: the `staging` git branch may not use the live
   production Supabase project, even if `VERCEL_ENV=production`.
5. **`scripts/promote-main-to-production.sh`**: retired; exits 1.

## Agent rules

- Never push feature branches expecting a Vercel deploy.
- Never merge directly to `production`. Never skip `staging`.
- Keep `staging` a strict fast-forward of `main`, and `production` a strict
  fast-forward of `staging`. Never commit unique work to either.
- Run `npm run ship:preflight` before promoting to production.
- See also `docs/ship-gate.md` and `AGENTS.md` § Branching & deployment.
