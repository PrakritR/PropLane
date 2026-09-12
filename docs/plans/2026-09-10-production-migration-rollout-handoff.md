# Production migration rollout preparation handoff

> **Superseded initial candidate evidence.** The bytes and digest below describe
> the candidate rejected by the fresh Astra review. They are preserved as
> historical evidence and are not approval for the corrected bundle. See
> `2026-09-10-production-migration-rollout-correction-1-handoff.md` for the
> correction-cycle digest and validation.

Date: 2026-09-11 UTC

Execution owner: fresh Sol-medium implementation manager

Plan: `docs/plans/2026-09-10-production-migration-rollout-plan.md`

Repository: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`

Branch: `akhil/backlog-repeat-issues`

Starting HEAD: `daddb7b5de9910ed3f140ff7d9a63beef48b0547`

Current HEAD: `daddb7b5de9910ed3f140ff7d9a63beef48b0547` (uncommitted review state)

## Outcome

The bounded preparation phase is implemented and locally verified. Nothing was
applied to staging or production, no protected branch was changed, and no
waiver was self-approved. The preparation script explicitly rejects `--apply`.

The generated preparation workspace contains validated fail-loud sentinels for
the supplied remote ledger versions plus exactly one pending bundle,
`20260911010000_production_recovery_schema.sql`. The bundle is deterministic:

- bytes: `215387`
- SHA-256: `3a14e51d45fb28df3acc70a382334fd58a77ff7354f707dd9f9b6475ecce109e`
- sources: exactly the 12 plan-listed files in timestamp order, with the source
  SHA-256 values pinned in `scripts/prepare-20260911-production-migrations.mjs`
- transaction guards: 3-second lock timeout, 60-second statement timeout,
  rollout-specific transaction advisory lock, fresh ledger/prerequisite/target
  absence checks before source SQL
- ledger: each original row stores its exact executable source SQL in
  `statements`; the 12 original names are inserted only after all 12 sources;
  CLI 2.117.0 may additionally record the bundle name

The generated command is dry-run-only and pins CLI 2.117.0 with `--skip-vault`.
It contains no roles or seed input and creates no persistent target connection
file. A future apply-capable command is deliberately absent.

## Decisions and corrections made during execution

- Migration parity now compares exact nonempty names, not versions. A matching
  name at a different version is applied; an equal version with a different
  name is missing. Extra remote-only names remain informational, but cannot
  satisfy missing local names. Empty/duplicate identities fail closed.
- Named targets are bound before `pg` import or network I/O to the expected dev,
  staging, or production project encoded in the direct host or pooler user.
  Argument ambiguity, URL override query parameters, malformed URLs, target
  mismatch, and unknown targets return NOT CHECKED / exit 2. Driver errors and
  credentials are suppressed.
- The first local CLI candidate used `LOCK TABLE` and was rejected with SQLSTATE
  `25P01`, because PostgreSQL permits that command only in an explicit
  transaction block. That rejected draft was not retained as the architecture.
  The final bundle uses `pg_try_advisory_xact_lock(723081447302)` and asserts in
  its first DO block that both SET LOCAL timeout values are active.
- The actual pinned CLI, rather than source inspection alone, established that
  compatible statements, source DDL, original ledger inserts, and the CLI
  ledger insert roll back together. No authored BEGIN/COMMIT or nontransactional
  statement is present.
- The deleted-identity access-key backfill reads the newly created, empty
  identity table during a first atomic install. It therefore does not rewrite
  existing financial rows at migration time. Snapshot's all-public-table lock
  is inside an installed function and is not invoked by the migration. Trigger
  installation still acquires ordinary DDL relation locks and changes later
  writes.

## Local PostgreSQL and pinned CLI rehearsal

`scripts/testing/production-migration-local-rehearsal.mjs` creates a private
`initdb` cluster on loopback and a short private socket path, using only the
minimal dependency fixture in
`scripts/testing/fixtures/production-migration-rehearsal-prerequisites.sql`.
It is not a production clone and is not complete account-recovery QA.

The final Node 22 rehearsal passed with CLI 2.117.0 and verified:

1. A sentinel whose represented remote ledger row disappears refuses execution
   before the bundle and leaves zero target objects and zero ledger rows.
2. Advisory-lock contention fails promptly and leaves zero target objects and
   zero migration ledger rows.
3. An injected failure in the middle of the source sequence rolls back every
   earlier object and ledger row.
4. An injected failure immediately before original ledger recording rolls back
   all source objects.
5. An injected failure after all 12 original ledger inserts, but before the
   CLI's own ledger insert, rolls back the objects and all 12 rows.
6. The unmodified bundle installs the exact 12 pinned sources; the ledger holds
   each original version/name with its exact SQL plus the CLI bundle row.
7. Expected tables, function signatures, RLS, and triggers exist; service role
   access succeeds; anon/authenticated reads are denied.
8. Baseline writes to ordinary public, auth, and storage fixture tables still
   succeed after installation.

The final cluster log showed PostgreSQL 17.11 accepting loopback connections,
each deliberate failure, expected permission denials, and a clean fast
shutdown. All eight exact task-owned disposable clusters were stopped and
deleted after capturing this summary; no unidentified process was stopped.

## Fresh remote read-only evidence owned by root Astra

`docs/plans/2026-09-10-production-migration-prerequisites.md` records the remote
checks. No execution delegate connected remotely.

- Production: all 13 prerequisite relations exist; all 115 ordinary public
  tables have primary keys; representative recovery/webhook objects, recovery
  triggers, and private recovery bucket are absent. The four vendor ownership
  FKs are CASCADE + NOT NULL and audit actor is NOT NULL, exactly the state the
  reviewed sequence changes.
- Staging: every repository migration name is represented and all representative
  objects resolve; 129 ordinary public tables have primary keys; 244 enabled
  account-prefixed triggers and the private recovery bucket exist; vendor FKs
  and audit actor already have the post-migration shape.

This is catalog evidence, not schema equivalence, production-sized lock testing,
or application/provider acceptance.

## Changed implementation files

- `scripts/check-migration-parity.mjs`
- `tests/unit/migration-parity-check.test.ts`
- `scripts/prepare-20260911-production-migrations.mjs`
- `tests/unit/production-migration-preparation.test.ts`
- `scripts/testing/fixtures/production-migration-rehearsal-prerequisites.sql`
- `scripts/testing/production-migration-local-rehearsal.mjs`
- `docs/waivers/2026-09-11-production-recovery-schema.md` (draft only)
- `docs/plans/2026-09-10-production-migration-rollout-handoff.md`

No file under `supabase/migrations/`, application runtime file, dependency, or
PRP-473 implementation was changed. Existing untracked future-issue notes were
preserved.

## Validation evidence

- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH npm exec vitest run tests/unit/migration-parity-check.test.ts tests/unit/production-migration-preparation.test.ts tests/unit/account-recovery-capture-sql.test.ts tests/unit/account-recovery-storage.test.ts tests/unit/account-recovery-shared-retention-sql.test.ts tests/unit/account-recovery-schema-compatibility.test.ts tests/unit/migration-versions-unique.test.ts -- --maxWorkers=2`
  - exit 0; 7 files, 116 tests passed
- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH node scripts/testing/production-migration-local-rehearsal.mjs`
  - exit 0; exact CLI install and contention/middle/pre-ledger/post-ledger
    rollback checks passed
- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH npx eslint scripts/check-migration-parity.mjs scripts/prepare-20260911-production-migrations.mjs scripts/testing/production-migration-local-rehearsal.mjs tests/unit/migration-parity-check.test.ts tests/unit/production-migration-preparation.test.ts`
  - exit 0, no output
- `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH npm run test:unit -- --maxWorkers=2`
  - exit 0; 1,377 files, 9,641 tests passed in 273.75 seconds
- `git diff --check`
  - exit 0
- typecheck
  - not run: repository defines no `typecheck` or `type-check` script
- application build/browser
  - not run: this is tooling/docs-only, and an existing server on port 3008 was
    not disturbed. Prior application/browser evidence is not claimed for these
    scripts.
- `npx graphify hook-rebuild`
  - exit 1: npm could not determine a Graphify executable; no graph exists in
    this keeper

No no-mistakes command, seed/wipe, provider call, commit, push, or deployment ran.

## Unresolved blockers and release gates

1. `docs/waivers/2026-09-11-production-recovery-schema.md` remains explicitly
   DRAFT. A human must confirm the named waiver, reviewed script SHA, and exact
   generated bundle digest before a separately reviewed apply-capable change.
2. The repository itself contains two different migrations named
   `agent_pending_actions` (`20260713000000` creates the original table;
   `20260716090000` widens portal/session columns). Staging additionally has a
   second ledger version for `resident_invite_links`. These are preexisting,
   unresolved name-identity ambiguities. The corrected checker intentionally
   returns nonzero rather than guessing; this is a guard-readiness blocker, not
   proof that those schemas are absent.
3. After excluding the 12 catalog-confirmed rollout omissions, the earlier
   name-parity inventory still leaves 21 local migration names that may be
   represented only by bundled history but have not been proven equivalent.
   Fresh production metadata contained 163 ledger rows, 33 missing local names
   total, and 10 extra applied names; none of those extra names was anonymous.
   This is not a claim that production has 21 remote bundles. Unknown remote
   names remain unresolved and cannot satisfy a missing repository name.
   Staging has all repository names, but production still lacks the 12 exact
   rollout names. A separate equivalence audit is required; no substring,
   comment, or blanket bundle equivalence was introduced.
4. Full E2E, deployed staging QA, production-sized lock/traffic testing,
   dedicated recovery/attachment/phone/provider acceptance, production Git
   release, and TestFlight distribution remain outstanding.
5. Before any eventual apply, rerun a fresh production ledger/catalog read,
   verify the approved source and bundle digests, run the reviewed dry-run,
   confirm backup/traffic ownership, and refuse any changed, partial,
   conflicting, or unverified already-complete state. Hold code promotion on
   any failed readback.

## Exact next-session prompt

Review `docs/plans/2026-09-10-production-migration-rollout-plan.md` and this
handoff against the uncommitted diff on `akhil/backlog-repeat-issues` at starting
HEAD `daddb7b5de9910ed3f140ff7d9a63beef48b0547`. Perform a fresh Astra security
and failure-mode review. Inspect the checker target binding and name ambiguity,
the preparation script's input/path/secret boundaries, exact source/digest and
ledger behavior, in-bundle prerequisites/absence/timeouts/advisory lock, the
pinned CLI rehearsal including post-ledger rollback, the draft-only waiver, and
all acceptance criteria. Do not access or write production/staging, edit SQL
migrations, approve the waiver, push protected branches, or run no-mistakes.
Record findings with severity and file/line references; if corrections are
needed, write a bounded correction plan for a fresh Sol-medium cycle.
