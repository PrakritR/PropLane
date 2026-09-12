# Production migration preparation: correction cycle 1 review

Date: September 11 UTC 2026. Fresh Astra review under the Akhil feature cycle.

Verdict: **APPROVED FOR PREPARATION KEEPER ONLY.** Both findings in the initial
review are resolved. No additional blocking finding was identified in the
bounded preparation/tooling diff. No second correction cycle is required.
This verdict does not approve the waiver, production application, or release.

Reviewed keeper: `akhil/backlog-repeat-issues`, HEAD
`daddb7b5de9910ed3f140ff7d9a63beef48b0547`, plus the stable uncommitted
preparation/correction diff. Inputs were the original rollout plan, review,
handoff, correction-1 plan and handoff, prerequisites, root validation, and
DRAFT waiver. The root's concurrent waiver edit only records the corrected
candidate fingerprints and bucket guards; its status remains DRAFT.

## Findings resolved

### P1: existing or concurrently inserted public recovery bucket

`scripts/prepare-20260911-production-migrations.mjs:182` refuses any
`account-recovery` bucket before source execution, after checking prerequisite
relations. Both public and private preexisting rows now fail for the intended
guard and remain unchanged.

The postcondition at line 193 executes after all 12 sources and before the
original ledger inserts. It selects the bucket `FOR UPDATE`, requires a row
with `public=false`, and retains the row lock through the transaction. This
handles a competing insertion after the absence check: the historical
`ON CONFLICT DO NOTHING` cannot silently retain a public bucket and allow the
bundle to commit. The concurrent row remains committed by its own transaction,
but the bundle's source objects and ledger rows roll back.

Independently ran the actual pinned CLI rehearsal. The synchronized competing
transaction reached the advisory barrier after preflight, inserted and
committed the public bucket, and triggered the postcondition's exact error.
Both preexisting-bucket cases, competing-row preservation, complete rollback,
and a clean install creating a private bucket passed.

### P2: unrelated CLI errors could satisfy deliberate-failure checks

`scripts/testing/production-migration-local-rehearsal.mjs:36` extracts the
first diagnostic line from the CLI's structured `error.message`. Both the
synchronous and asynchronous expected-failure helpers require exact equality
with the intended message and SQLSTATE. A later source excerpt containing the
expected words cannot satisfy that check; the harness exercises this negative
case before opening its local database.

The independent run verified the sentinel and contention errors (`P0001`),
each of the three injected division-by-zero errors (`22012`), both preexisting
bucket errors (`P0001`), and the competing public-bucket postcondition error
(`P0001`). The PostgreSQL log independently confirms those actual failures,
so the rollback evidence is not inferred merely from a nonzero child exit.

## Broader preparation assessment

The manifest still pins exactly the 12 reviewed source files in stable order.
Independent regeneration produced:

- Bundle: `20260911010000_production_recovery_schema.sql`, `215925` bytes.
- Bundle SHA-256:
  `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`.
- Preparation script SHA-256:
  `ae442ea1193137a2f2d44dcde67c479675bacfe63cd494dcfb95defac3a17263`.

The CLI entrypoint continues to reject `--apply` and arbitrary arguments. It
accepts restricted ledger metadata, creates a private temporary workspace,
and emits only the pinned production dry-run command with `--skip-vault`.
It loads no credentials and makes no connection. Sentinels fail loudly if
their represented historical ledger entries disappear. Partial/conflicting
target identities refuse preparation, and exact complete metadata produces no
replay workspace. The generated bundle preserves source SQL and records each
original migration only after successful source execution and the privacy
postcondition.

The parity checker remains conservative: exact nonempty names determine
coverage, duplicate/anonymous identities fail, named targets are bound before
database I/O, endpoint-override URL parameters are refused, and driver errors
are suppressed. Extra historical names do not satisfy missing local names.
This review does not resolve the existing duplicate-name or historical bundle
equivalence issues.

## Independent commands and evidence

All Node commands used
`PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH`.

- `npm exec vitest run tests/unit/migration-parity-check.test.ts tests/unit/production-migration-preparation.test.ts tests/unit/account-recovery-capture-sql.test.ts tests/unit/account-recovery-storage.test.ts tests/unit/account-recovery-shared-retention-sql.test.ts tests/unit/account-recovery-schema-compatibility.test.ts tests/unit/migration-versions-unique.test.ts -- --maxWorkers=2`
  - Exit 0; 7 files / 116 tests passed.
- `node scripts/testing/production-migration-local-rehearsal.mjs`
  - Exit 0; actual `npx -y supabase@2.117.0` exercised exact install,
    sentinel/contention, all three rollback positions, both existing buckets,
    synchronized competing public bucket, source/ledger rollback, service-role
    access, denied anon/authenticated reads, ordinary public/auth/storage
    fixture writes, and final bucket privacy.
  - Preserved log: `/tmp/proplane-migration-rehearsal-VVTDmx/postgres.log`.
    Actual errors are at log lines 6, 12, 40, 44, 48, 52, 80, and 108;
    expected permission denials are at lines 121 and 123. Clean shutdown is
    recorded at line 131. Only the log remains: the harness removed its own
    PostgreSQL data/socket directories after successful `pg_ctl -w stop`.
- `npx eslint scripts/check-migration-parity.mjs scripts/prepare-20260911-production-migrations.mjs scripts/testing/production-migration-local-rehearsal.mjs tests/unit/migration-parity-check.test.ts tests/unit/production-migration-preparation.test.ts`
  - Exit 0; no output.
- `node scripts/prepare-20260911-production-migrations.mjs --apply`
  - Exit 1; explicit preparation-only refusal.
- `git diff --exit-code daddb7b5de9910ed3f140ff7d9a63beef48b0547 -- src supabase/migrations package.json package-lock.json`
  - Exit 0; application source, historical migrations, and dependencies unchanged.
- `git diff --check`
  - Exit 0 before the review artifact was added; repeated after writing it.

The earlier 9,641-test full unit suite, typecheck, and full lint remain prior
execution/root evidence, not reviewer reruns. This review changes only its own
documentation. The execution's unavailable Graphify command and absent graph
remain documented limitations; no graph was changed or represented as current.

## Release boundary

No reviewer staging/production access or write, provider call, seed/wipe,
protected push, waiver approval, production apply, or no-mistakes command ran.
Root independently regenerated the same corrected fingerprints from its fresh
read-only production ledger during this review; its remote dry-run/catalog
results belong in root validation and are not reviewer-executed checks.

The named waiver remains DRAFT and `--apply` remains rejected. Unknown
historical equivalence and duplicate migration names still prevent a green
parity verdict. Any apply-capable change requires the named confirmation and
fresh review described in the rollout plan. Full E2E, deployed staging QA,
production-sized lock/traffic checks, recovery/attachment/provider acceptance,
the protected release ladder, and TestFlight distribution remain outstanding.
The local dependency fixture proves bounded installation behavior, not those
application and production acceptance gates.
