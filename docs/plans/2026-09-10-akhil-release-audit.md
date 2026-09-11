# Akhil release-readiness audit

Date: 2026-09-10

Scope: read-only audit for placing the reviewed PRP-473 fixes into production and correcting Akhil-specific instructions. No source edit, database write, provider send, credential change, branch mutation, merge, push, deployment, PR, or no-mistakes invocation was performed. This file is the only artifact written by this audit.

## Decision

PRP-473 is approved for keeper handoff by the final fresh review in `docs/plans/2026-09-10-prp-473-resumed-review.md`. That review records closure of the two prior P2 reply defects, focused 10-file validation (189 tests), attributed full unit/typecheck/lint/build results, and dev browser evidence. It explicitly does not approve production and does not establish handset/provider acceptance.

The safe release path is therefore:

1. Root integrates the keeper into the current `main` line and reruns the PRP-473 focused tests plus full unit, typecheck, lint, build, and `git diff --check` on the integrated tree.
2. Recreate `origin/staging` from `origin/main` using the existing fast-forward-only `npm run ship:staging` script. Its missing-branch path is an explicit `git push origin origin/main:refs/heads/staging`; it does not rewrite an existing branch.
3. Perform dedicated staging QA, including the tour pending/reschedule/duplicate/ambiguity/error paths and the documented provider/handset limits. Do not write production application data.
4. Run `npm run ship:preflight`, resolve every failure, then use `npm run ship:production` only after staging sign-off. This fast-forwards `origin/staging` to `production`, never `main` directly.
5. Verify the resulting Vercel Production deployment and the GitHub `iOS TestFlight` workflow, including its internal-group distribution step.

## Repository and ref evidence

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
- Keeper: `akhil/backlog-repeat-issues` at `cdfd2debe67a26d9ae0e01dc743c754d68ece2b6`.
- `origin/main` and `origin/production`: `2d1353af42c3a652be6cf8a69640468b453f4cea`.
- `git ls-remote` shows remote `main` and `production`, but no remote `staging`. Any stale local tracking ref must not be treated as a deployable branch.
- Keeper is not a release ref. It contains the PRP-473 source/tests and review artifacts ahead of the current remote release line; integration must reconcile the newer `main` changes first.
- Keeper has unrelated untracked Akhil planning files. Root must choose deliberately what to carry; do not accidentally include them in a release commit.
- `scripts/promote-main-to-production.sh` fails closed and must remain unused. `scripts/promote-main-to-staging.sh` is the documented staging recreation path and checks ancestry for an existing branch.
- Current `npm run ship:preflight` cannot pass until remote staging exists; its dirty-tree and shell-local environment notices are also not release approval.

## Vercel and GitHub evidence

- Read-only `vercel project inspect proplane` found the actual live project `proplane`, ID `prj_rupckw3T2v0oXVg2nTLVCYePKDUc`, owner `prakritramachandran-6082's projects`, Next.js, Node 24.x. Do not relink or create another project.
- `vercel project ls` shows `proplane` serving `https://prop-lane.space`. It also shows a separate `axis-2` project with no production URL. Repository references calling `axis-2` the live project are stale for this release.
- Read-only Vercel deployments show recent Ready Production and Preview deployments for `proplane`; this does not prove the desired future commit is deployed.
- Vercel domains include `prop-lane.space` and `staging-prop-lane.space`.
- The local checkout is not linked (`.vercel/project.json` is absent), so `vercel env ls` cannot inspect project environment names without a link operation. No link or env pull was attempted. Missing shell variables are not evidence that Vercel Production configuration is absent.
- GitHub CLI auth is available read-only. The canonical repository resolves to `PrakritR/PropLane` (the configured `origin` URL is the older `PrakritR/AXIS-2` name). Required secret *names* are present, including `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, App Store Connect values, and test/staging credentials. Values were not printed.
- Recent GitHub runs for production commit `2d1353af` show successful `Vercel Deploy` and `iOS TestFlight`; recent staging runs for `0b6d567` are historical and do not replace the missing current remote staging ref.
- Branch protection API returned no protection record for `main`; this is an observation, not permission to bypass the ladder.

## Release blockers and required checks

1. Integrate PRP-473 with current `main`; the keeper review is not evidence against the newer release-line changes.
2. Recreate remote `staging`, then run real staging QA before production.
3. Re-run the required automated checks on the integrated tree. Prior green results are attributed in the handoff but are not a substitute for post-integration validation.
4. Complete real staging checks for email routing and, if enabled, SMS provider/handset delivery, STOP/START, YES/alternate-time, stale/duplicate replies, and receipts. Hermetic tests do not prove provider delivery.
5. Confirm Vercel `proplane` Production branch/environment configuration through the existing project owner/dashboard or a safely linked read-only CLI context. Do not relink to `axis-2`.
6. Confirm staging uses its branch-scoped non-production Supabase environment and production remains the live environment. Do not run seed, migration, or application-data writes against production.

## Instruction correction boundary

Akhil’s matching developer file explicitly says no Linear/Lavish workflow and no no-mistakes unless Akhil asks, and no captain merge. Captain-only permission blockers must not be retained for Akhil. Prakrit’s separate developer instructions remain captain-specific. The release ladder, staging QA, production-data lock, fast-forward-only rule, and no-force-push rule remain applicable to everyone.

## Safe commands for the release owner

```text
# after integration and current-main validation
npm run ship:staging
# dedicated QA on staging-prop-lane.space
npm run ship:preflight
npm run ship:production
# then inspect Vercel proplane and the iOS TestFlight workflow
```

Do not run these commands from this audit worktree, and do not substitute a direct `main` → `production` push.
