# Production migration preparation: correction cycle 1 handoff

Date: September 11 UTC 2026

Execution owner: fresh Sol-medium manager with Terra and Luna delegates

Correction plan: `docs/plans/2026-09-10-production-migration-rollout-correction-1.md`

Original plan: `docs/plans/2026-09-10-production-migration-rollout-plan.md`

Repository: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`

Branch: `akhil/backlog-repeat-issues`

Starting and current HEAD: `daddb7b5de9910ed3f140ff7d9a63beef48b0547` plus the uncommitted preparation and correction diff

## Outcome

Both correction-cycle findings are addressed in the local preparation bundle
and real-CLI rehearsal. This handoff requests a fresh Astra review. It does not
approve the draft waiver, declare release readiness, or authorize production
application.

The corrected deterministic bundle
`20260911010000_production_recovery_schema.sql` is:

- bytes: `215925`
- SHA-256: `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`
- preparation script SHA-256: `ae442ea1193137a2f2d44dcde67c479675bacfe63cd494dcfb95defac3a17263`
- sources: the same 12 manifest-pinned historical files, byte-for-byte and in
  the same stable order

The initial candidate's 215387-byte digest
`3a14e51d45fb28df3acc70a382334fd58a77ff7354f707dd9f9b6475ecce109e`
is preserved in the original handoff and root-validation artifact as
superseded evidence of the rejected candidate. It is not a corrected digest.

## Corrections

### Existing and concurrently inserted recovery buckets

The bundle still checks prerequisite relations before reading
`storage.buckets`. It then refuses any existing row whose id is
`account-recovery`, regardless of its `public` value, before any of the 12
source files execute. The dedicated error is
`production recovery bucket is no longer absent`.

There is also a post-source, pre-ledger privacy guard. It selects that bucket
row `FOR UPDATE`, requires it to exist with `public=false`, and holds the row
lock through the bundle transaction. This closes the race where another
transaction inserts a public bucket after the absence check but before the
historical source's `ON CONFLICT DO NOTHING`. A changed row produces
`production recovery bucket is not private after install`; the bundle objects
and original/CLI ledger writes roll back, while the independently committed
bucket row remains unchanged.

No historical migration was edited. The original ledger inserts still occur
only after every exact source and the privacy postcondition.

### Failure-diagnostic rehearsal

The local harness no longer accepts an arbitrary failing subprocess. It parses
the pinned CLI's structured SQL error and requires the exact reported first
line, including SQLSTATE:

- historical sentinel: `P0001`
- rollout advisory contention: `P0001`
- middle, pre-ledger, and post-ledger injected division by zero: `22012`
- preexisting public/private bucket guard: `P0001`
- concurrent post-preflight public-bucket privacy postcondition: `P0001`

A source-echo self-check proves expected words appearing later in migration
source cannot satisfy the matcher. Every deliberate failure then asserts zero
manifest/bundle ledger rows and zero generated tables, functions, and triggers.

The public and private preexisting-bucket cases preserve each exact fixture row
and delete only that row between cases. The synchronized concurrency case
holds a rehearsal-only advisory barrier after preflight, commits a distinct
public bucket before the bucket-creation source, releases the barrier, and
verifies the postcondition rollback and exact competing-row preservation. The
clean install asserts exactly `public=false` for `account-recovery`.

## Ownership and changed correction files

- Terra: `scripts/prepare-20260911-production-migrations.mjs` and
  `tests/unit/production-migration-preparation.test.ts`
- Luna: `scripts/testing/production-migration-local-rehearsal.mjs`
- Sol integration: exact structured diagnostics, complete object rollback
  checks, concurrent insertion coverage, task-owned local data cleanup, and
  phase documentation
- Documentation: this handoff and the superseded label in
  `docs/plans/2026-09-10-production-migration-rollout-handoff.md`

The correction did not change the parity checker policy, app runtime,
`supabase/migrations`, dependencies, or the DRAFT waiver.

## Validation

- Node 22 focused parity/preparation/recovery suite:
  `npm exec vitest run tests/unit/migration-parity-check.test.ts tests/unit/production-migration-preparation.test.ts tests/unit/account-recovery-capture-sql.test.ts tests/unit/account-recovery-storage.test.ts tests/unit/account-recovery-shared-retention-sql.test.ts tests/unit/account-recovery-schema-compatibility.test.ts tests/unit/migration-versions-unique.test.ts -- --maxWorkers=2`
  - exit 0; 7 files and 116 tests passed
- Node 22 actual local PostgreSQL rehearsal:
  `node scripts/testing/production-migration-local-rehearsal.mjs`
  - exit 0 with pinned `npx -y supabase@2.117.0`
  - passed sentinel, contention, three injection points, public/private
    preexisting buckets, concurrent public bucket, complete rollback, exact
    successful ledger/source installation, access controls, baseline writes,
    and private-bucket assertions
  - preserved evidence: `/tmp/proplane-migration-rehearsal-H2Ksd4/postgres.log`
  - the log contains each intended error and a clean shutdown; the task-owned
    PostgreSQL data and socket directories were removed after stop, leaving
    only the evidence log
- Preparation-only rejection:
  `node scripts/prepare-20260911-production-migrations.mjs --apply`
  - exit 1 with the explicit preparation-only refusal
- Scoped ESLint, `git diff --check`, protected-scope diff, and graph refresh:
  - scoped ESLint exit 0 with no output
  - `git diff --check` exit 0
  - `git diff --exit-code daddb7b5de9910ed3f140ff7d9a63beef48b0547 -- src supabase/migrations package.json package-lock.json`
    exit 0; app runtime, historical migrations, and dependencies remain unchanged
  - `npx graphify hook-rebuild` exit 1 because npm could not determine a
    Graphify executable; no graph exists or was changed in this keeper

The prior execution's full unit suite (1,377 files / 9,641 tests), TypeScript
check, and full lint (0 errors / 726 existing warnings) remain reusable prior
evidence as allowed by the correction plan. They are not claimed as fresh
correction-cycle runs. This tooling/docs-only correction has no browser surface.

## Safety and remaining gates

No staging/production connection or write, provider action, seed/wipe,
protected push, production apply, waiver approval, or no-mistakes command ran.
`--apply` remains rejected and
`docs/waivers/2026-09-11-production-recovery-schema.md` remains DRAFT.

Fresh Astra review is required next. After that review, root Astra will repeat
the bounded production read-only ledger/catalog check and dry-run on the
corrected candidate. The unresolved migration-name equivalence work, named
waiver confirmation, separately reviewed apply-capable path, full E2E, deployed
staging QA, production-sized traffic/lock testing, recovery/attachment/provider
acceptance, protected release ladder, and TestFlight distribution remain gates.

## Exact next-session prompt

Perform a fresh Astra correction review of
`docs/plans/2026-09-10-production-migration-rollout-correction-1.md`, this
handoff, the original plan/review/handoff/root-validation/prerequisites, and the
uncommitted diff on `akhil/backlog-repeat-issues` at
`daddb7b5de9910ed3f140ff7d9a63beef48b0547`. Independently verify the
transaction-time any-bucket refusal, prerequisite ordering, post-source
row-locking privacy postcondition, original-source and ledger ordering, exact
structured SQLSTATE diagnostics, source-echo negative, public/private fixture
preservation, concurrent insertion rollback, clean private-bucket success, and
final commands. Do not access or write staging/production, change checker
policy/app/historical migrations/dependencies, approve the waiver, enable
apply, push protected branches, or run no-mistakes. Record findings with
severity and file/line references. This is the fresh review after correction
cycle 1 of at most two automatic correction cycles.
