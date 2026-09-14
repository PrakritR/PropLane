# Tour follow-up recovery guard handoff

Date: 2026-09-13

Status: **BOUNDED CODE AND TEST PREPARATION COMPLETE; REMOTE APPLY AND FRESH REVIEW REMAIN**

Plan: `docs/plans/2026-09-13-tour-followup-recovery-release-plan.md`

This handoff grants no Git, database, provider, deployment, or production authority. No remote database call, migration apply, provider call, browser run, commit, push, or promotion occurred in this work.

## Scope and ownership

- Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`
- Keeper: `akhil/prp-472-inbox-unread`
- Starting HEAD remained `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b` throughout this bounded preparation.
- Root owns Git, migration application, remote database probes, broad validation, release decisions, and the staging to production ladder.
- The concurrent inbox manager owns browser QA and its own handoff. No inbox source was edited here.
- The Akhil feature cycle was followed with a sequential Terra migration implementation and Luna test/probe review. No no-mistakes, Linear, Lavish, or global graph repair ran.

## Prepared artifacts

### Additive migration

`supabase/migrations/20260913173000_tour_followup_recovery_guards.sql`

- Uses one explicit transaction.
- Fails closed unless `public.manager_tour_followup_controls` is an exact ordinary or partitioned table and both exact zero-argument recovery functions exist with trigger return types.
- Creates the normal `account_recovery_write_guard` row trigger for BEFORE INSERT/UPDATE/DELETE and `account_recovery_capture_delete` row trigger for AFTER DELETE.
- A repeated apply accepts an existing trigger only when its function OID, PostgreSQL event mask, enabled state, argument count, WHEN clause, internal flag, and constraint identity exactly match.
- A conflicting same-named trigger raises and rolls back. It never silently counts as installed.
- It does not change functions, columns, data, ownership classification, restore policy, RLS, table grants, or historical migrations.

### Focused executable coverage

`tests/unit/tour-followup-recovery-guards-sql.test.ts`

- Reproduces the installation order that caused the gap: historical recovery triggers are installed before the tour controls table is created.
- Proves exact, idempotent trigger installation with event masks `31` and `9`, exact public function identities, normal enabled state, zero arguments, no WHEN clauses, no constraint triggers, and no internal triggers.
- Proves a conflicting capture trigger rejects the migration and rolls back the guard trigger created earlier in the same transaction.
- Proves missing table and missing function prerequisites fail before creating any non-internal trigger.
- Preserves the controls table's RLS posture and direct privilege contract: anon and authenticated cannot select; service role can select.
- Drives the real recovery chain: a manager control row is snapshotted into one delete hold, an ordinary held update is blocked, the held archival delete is allowed, the AFTER DELETE trigger marks the retained record archived, and `account_recovery_finish_archival` reaches retained state.
- Executes the reviewed SQL probe itself after removing only its psql `\set` meta-command, then verifies its synthetic auth, request, record, and hold data did not leak.

### Rollback-only remote probe

`scripts/testing/tour-followup-recovery-guards-probe.sql`

The probe is intended for root's explicit DEV/staging execution after the candidate migration is present. Run it with stop-on-error semantics. When using the Supabase Management API instead of psql, strip only the `\set ON_ERROR_STOP on` line. Keep all SQL assertions and both rollback boundaries.

The probe:

1. Verifies exactly two non-internal controls triggers and their exact function identities, event masks, enabled state, argument count, WHEN clauses, and constraint identity.
2. Refuses to start if its hard-coded synthetic UUID, email, control key, recovery request, recovery record, or recovery hold already exists.
3. Creates only a synthetic manager auth/profile/role and one synthetic controls row inside a rollback transaction. The profile and role inserts tolerate an environment-added auth provisioning trigger without touching any pre-existing identity because the fixture guard runs first.
4. Calls `account_recovery_begin` with the existing manifest policy for `manager_tour_followup_controls`, then explicitly clears the transaction-local internal marker to model the next application transaction.
5. Requires the held update to fail with `Account recovery decision required`.
6. Deletes only the exact held controls row through the ordinary allowed archival path.
7. Before finalization, requires exactly one matching delete hold with `archived=true`, `recoverable=true`, `phase=2`, `snapshot_complete=true`, request state `archiving`, and no remaining live controls row.
8. Calls `account_recovery_finish_archival` and requires request state `retained`.
9. Rolls back, then uses a second read-only transaction to assert zero synthetic auth, profile, role, control, request, record, and hold rows.

It never invokes broad account purge, auth deletion, object purge, provider operations, queues, or messages. Root should retain the returned catalog/lifecycle rows as execution evidence. An error aborts the transaction; do not turn an error into a cleanup attempt against a different identity.

## Validation

All commands ran from the worktree with Node `v22.23.0`, `NODE_OPTIONS=--max-old-space-size=4096`, and serialized Vitest workers.

1. Final focused matrix:
   - `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/tour-followup-recovery-guards-sql.test.ts tests/unit/tour-interest-reminder-sql.test.ts tests/unit/account-recovery-capture-sql.test.ts --maxWorkers=1 --reporter=verbose`
   - Exit 0: 3 files, 40 tests passed, duration 9.34 seconds.
2. Scoped ESLint:
   - `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/eslint/bin/eslint.js tests/unit/tour-followup-recovery-guards-sql.test.ts`
   - Exit 0, no output.
3. `git diff --check`
   - Exit 0, no output.

One earlier non-final matrix run had 38 passes and one fixture assertion failure because it counted the table's two internal foreign-key triggers. The assertion was corrected to count only non-internal triggers. The final matrix above passed.

## Artifact fingerprints

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `supabase/migrations/20260913173000_tour_followup_recovery_guards.sql` | 2,799 | `9f9bc0e0b3e7059e88b60adc27736615ee45eaf71ad964404931fda77d29be14` |
| `tests/unit/tour-followup-recovery-guards-sql.test.ts` | 13,669 | `d9ccc5acf8fe47d4b96b1955bcf26ac5711adb056a8e18237b2661f86e0882ae` |
| `scripts/testing/tour-followup-recovery-guards-probe.sql` | 12,567 | `a65f601e839c2740e296ded12e518b783c20044e427dce5382a492845bd33b0d` |

## Known limits and remaining gates

- The remote probe has not run. PGlite proves SQL behavior against the repository definitions; it does not replace root's DEV/staging catalog and lifecycle execution against actual functions.
- Root reported read-only aggregate checks on staging and production returned no uncaptured controls holds. This preparation made no independent database query and does not repair historical requests.
- The production controls table remains absent until the older tour prerequisite is separately authorized and applied in the required order. This migration fails closed if that table or the recovery functions are missing.
- The migration does not broaden the recreatable table list. A recovered controls row follows the existing recoverable phase-2 policy rather than becoming a fresh settings generation.
- Fresh Astra/security review must assess the integrated candidate, exact artifact hashes, probe output, and the broader prerequisite release before any apply or publication.
- Root still owns focused remote rehearsal, migration ledger/readback handling, staging QA, ship preflight, protected-branch movement, and any request for additional production mutation authority.
