# Communication billing preparation: independent Astra review

September 11, 2026. Reviewed in the assigned pool worktree on
`akhil/backlog-repeat-issues`, HEAD `dbb3836e36ec23abd347f16d3eb1b7df7270b015`.
Review duration: approximately 3 minutes. Scope is preparation only. No remote
operation, credential read, application QA, commit, push, or approval occurred.

Disposition: **correction required for validation evidence**, then fresh Astra
review. No production or application-release approval is implied. The waiver
remains DRAFT. No candidate SQL defect was established in this focused review.

## Findings

- **P2: safety-gate and atomicity evidence is incomplete.**
  `scripts/testing/comms-billing-migration-local-rehearsal.mjs:86` executes source
  prefixes in a manually opened transaction, catches any error, and explicitly
  rolls back. It does not test failure within the generated candidate, and an
  unexpected earlier source failure can satisfy this test. Lines 88 and 93 test
  standalone backfill semantics and three conflicts, but never run the candidate
  against a qualifying backfill row despite the comment and handoff claiming this
  gate was exercised. The plan explicitly requires these failure paths. Existing
  live-style usage/settings writes after installation are also not exercised.
- **P2: concurrency test can hide unexpected errors.** At the same file's line
  99, counting 66 fulfilled allowed reservations permits the other 14 promises
  to reject unexpectedly. It does not establish explicit insufficient-credit
  denials or the final wallet balance.
- **P3: unchanged-certificate evidence names a nonexistent path.** The handoff's
  unchanged-file command uses `scripts/certs/supabase-root-2021-ca.pem`. The actual
  consumed certificate is `scripts/lib/supabase-root-2021.crt`. Independent review
  checked the actual path and found it unchanged; this is a documentation error.

## Verified implementation properties

The CLI accepts no arguments, rejects apply/input options, and reads pinned Git
objects plus the fixed local correction. Exact bytes and digests are revalidated
even for caller-supplied manifest objects. The bundle has a single explicit
transaction, bounded lock/statement waits, advisory lock, target/ledger absence
checks, and a settings relation lock before the exact qualifying-backfill test.
The source and ledger representations preserve the six reviewed source strings.
The auxiliary ledger representation is outside its own hash material.

The successful real PostgreSQL rehearsal demonstrates the missing historical
recovery triggers, additive correction idempotence, held purchase insert/update
blocking, legitimate deletion capture, and purchase/adjustment restoration. It
also executes the candidate postchecks for RLS, grants, exact RPC signatures and
configuration, defaults, constraints, index, singleton, and four trigger shapes.
Clean installation preserves the historical ledger and reads back six exact
source statements plus the complete-bundle auxiliary row. The new tables are
required absent, so correction creation occurs on newly created tables within
the same transaction. No existing recovery function is replaced.

## Independent command results

All commands ran in `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.

- `node scripts/testing/comms-billing-migration-local-rehearsal.mjs`: exit 0.
  Disposable localhost PostgreSQL only, with cleanup. `initdb` and `pg_ctl`
  resolved under `/opt/homebrew/bin`.
- `npx vitest run tests/unit/comms-billing-migration-preparation.test.ts --maxWorkers=1`:
  exit 0, nine tests passed, reported duration 1.81 seconds.
- `npx eslint scripts/prepare-20260911-comms-billing-migrations.mjs scripts/testing/comms-billing-migration-local-rehearsal.mjs tests/unit/comms-billing-migration-preparation.test.ts`: exit 0.
- `node --check scripts/prepare-20260911-comms-billing-migrations.mjs`: exit 0.
- `node --check scripts/testing/comms-billing-migration-local-rehearsal.mjs`: exit 0.
- `node scripts/prepare-20260911-comms-billing-migrations.mjs`: exit 0;
  67,040-byte bundle digest
  `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`.
- `shasum -a 256 scripts/prepare-20260911-comms-billing-migrations.mjs scripts/testing/comms-billing-migration-local-rehearsal.mjs tests/unit/comms-billing-migration-preparation.test.ts scripts/lib/supabase-root-2021.crt`:
  exit 0; entrypoint, rehearsal, and unit fingerprints match the handoff. Actual
  CA digest is `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.
- `git diff --exit-code HEAD -- supabase/migrations scripts/prepare-20260911-production-migrations.mjs scripts/testing/production-migration-local-rehearsal.mjs scripts/lib/supabase-root-2021.crt docs/waivers/2026-09-11-production-recovery-schema.md`: exit 0.
- `git diff --check`: exit 0. This does not validate untracked artifact contents;
  the explicit new files were inspected and tested independently.

## Bounded correction plan

Use a fresh Sol implementation session. Change only the local rehearsal and its
handoff evidence; keep all candidate, correction SQL, pinned-source and consumed
runner/CA bytes unchanged. Do not implement an apply path.

1. Execute the actual bundle on a baseline containing one qualifying backfill
   row. Assert its specific rejection, unchanged settings and historical ledger,
   and absence of candidate artifacts after rollback, using a fresh connection.
2. Test SQL-injected failures after sources 1, 5 and 6 in the actual generated
   bundle. Test-only injection must not alter the production builder. Assert the
   intended injected failure occurs, then fresh-connection rollback of candidate
   objects/columns and all new ledger identities, preserving historical state.
3. After clean installation, exercise representative pre-credit usage insertion
   and existing settings writes. Assert expected legacy defaults and preserved
   values, without provider or application calls.
4. Assert all 80 reservation promises fulfill, exactly 66 are allowed, exactly
   14 explicitly deny for insufficient allowance, and final remaining balance
   equals 2 cents. Unexpected errors must fail the rehearsal.
5. Fix the CA path in the handoff and update only changed test fingerprints and
   actual evidence. Rerun focused rehearsal, unit, syntax, lint, and unchanged
   candidate/consumed-file hashes. Return for fresh Astra review.

Production remains subject to main integration, identical canonical correction
adoption, staging schema and application QA, legacy-invoicer cutover proof,
fixed apply-runner review, fresh target checks, and a separately approved named
waiver. This review does not independently refresh root's remote metadata.
