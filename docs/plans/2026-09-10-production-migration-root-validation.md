# Root validation of migration preparation

September 11 UTC 2026. Keeper starting HEAD `daddb7b5de9910ed3f140ff7d9a63beef48b0547`. No production application SQL, migration repair, provider send or protected-branch push.

## Initial execution candidate

- Node 22 `npx tsc --noEmit --pretty false --incremental false`: exit 0.
- Node 22 `npm run lint`: exit 0, 0 errors / 726 existing warnings.
- `git diff --exit-code daddb7b5de9910ed3f140ff7d9a63beef48b0547 -- src supabase/migrations package.json package-lock.json`: exit 0. App source and historical migrations remain unchanged.
- `node scripts/prepare-20260911-production-migrations.mjs --apply`: exit 1, explicit preparation-only refusal.
- `git diff --check`: exit 0.
- Independent manifest/bundle generation: 12 sources, 215387 bytes, SHA-256 `3a14e51d45fb28df3acc70a382334fd58a77ff7354f707dd9f9b6475ecce109e`.

Root passed the fresh production read-only ledger metadata to the preparation script in memory. It generated a private temporary directory, not a worktree or linked project. No production credentials were written to disk. The pinned command then ran with mandatory `--dry-run --skip-vault --project-ref qahnczmilgptcedaqype`:

```
npx -y supabase@2.117.0 db push --project-ref qahnczmilgptcedaqype --skip-vault --workdir /var/folders/n7/whxw24l127j04lh_4lpgxsn80000gn/T/proplane-production-migrations-XyiYOP --dry-run
```

Exit 0. Reported `dryRun: true`, exactly `20260911010000_production_recovery_schema.sql` pending, `seeds: []`, `roles: []`. This checks CLI migration selection, not SQL application or deployed app acceptance.

## Review hold

Fresh Astra review reproduced a first-install guard gap: a pre-existing public `account-recovery` bucket survives the initial bundle because the source migration uses ON CONFLICT DO NOTHING. The earlier read-only production check found that bucket absent, but a future changed state must also fail closed inside the migration transaction. Review also requires the local harness to verify the expected SQLSTATE/message for deliberate failures, not accept arbitrary CLI errors. The initial candidate is not approved for production. Follow the fresh review/correction artifacts and do not reuse the initial digest as approval of corrected bytes.

## Corrected candidate and final preparation review

Correction cycle 1 resolved both findings. Fresh Astra review approved preparation
on the keeper only, independently passing 116 tests, scoped lint, and the actual
pinned-CLI local PostgreSQL rehearsal, including the concurrent public-bucket
race and exact failure diagnostics. See the correction-1 review for commands.
The earlier full unit suite (9,641 tests), typecheck, and full lint are initial
candidate evidence, not reruns after the tooling correction.

Root regenerated the candidate from a fresh read-only production ledger:

- Bundle: `20260911010000_production_recovery_schema.sql`, 215925 bytes.
- Bundle SHA-256: `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`.
- Script SHA-256: `ae442ea1193137a2f2d44dcde67c479675bacfe63cd494dcfb95defac3a17263`.

```
npx -y supabase@2.117.0 db push --project-ref qahnczmilgptcedaqype --skip-vault --workdir /var/folders/n7/whxw24l127j04lh_4lpgxsn80000gn/T/proplane-production-migrations-4E5NJa --dry-run
```

Exit 0. Exactly the corrected bundle was pending, `dryRun: true`, `seeds: []`,
`roles: []`. No migration was applied. This is selection evidence, not SQL
execution against production or deployed application acceptance.

The named waiver remains DRAFT. Historical duplicate names and unresolved bundle
equivalence still prevent a green migration-parity verdict. Full E2E, deployed
staging QA, production-sized lock checks, recovery/provider acceptance, and
release/distribution gates remain outstanding. Graph refresh was attempted by
execution but exited 1 because npm could not find the executable; no graph
exists and no graph freshness is claimed.

## Concurrent upstream release drift

Read-only remote inspection and fetch found `main` and `staging` had advanced to
`8ce3868b4e5775661956c6c3f36fcb146bfa931a`. Production remained at
`2d1353af42c3a652be6cf8a69640468b453f4cea`; the keeper remote was still at the
starting HEAD above. No protected branch was modified.

The newer upstream includes communication billing/campaign changes, five more
migrations, listing-editor work, and an overlapping SMS dispatcher change.
These are outside this reviewed preparation diff. Integrate and revalidate them
before any subsequent release; do not treat this 12-source preparation package
as covering those newer migrations or the new staging deployment.

`npm run sandbox:open -- --port 3008 /portal/tours/upcoming` exited 0.
Review URL: http://localhost:3008/portal/tours/upcoming. This is the existing
PRP-473 local review surface, not new browser evidence for migration tooling.
