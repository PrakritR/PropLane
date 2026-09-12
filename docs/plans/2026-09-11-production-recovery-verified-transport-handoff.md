# Verified production-recovery transport handoff

Date: September 11 2026. Outcome: **IMPLEMENTED, LOCALLY REHEARSED, FROZEN FOR INDEPENDENT REVIEW**.

Plan: `docs/plans/2026-09-11-production-recovery-verified-transport-plan.md`.
Repository: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
Keeper: `akhil/backlog-repeat-issues`.
Starting and current HEAD: `10962d8f3734b8424a98d4fa910fcd561943e60a`.

No remote database/provider command, credential acquisition, production preflight, production apply, commit, push, merge, promotion, dependency edit, application-source edit, or historical migration edit occurred. The named waiver remains unconsumed and root retains sole authority for remote read-only gates and any one-shot apply after approval.

## Implemented decision

The rejected CLI write path is gone. The named entrypoint now uses pinned Supabase CLI 2.117.0 only for read-only `db dump --dry-run` temporary-login acquisition from a mode-700 private config workspace and an allowlisted child environment. It validates the exact production host/project-scoped user/port/database and pinned CA before constructing a `pg` client with certificate and hostname verification.

Apply uses one explicit `BEGIN`, `SET LOCAL ROLE postgres`, the unchanged 215925-byte bundle, and one auxiliary ledger insert whose `statements` value is exactly `[completeBundle]`. It validates the complete preserved historical ledger, all 12 exact source rows, the auxiliary row, functions by types-only identity, trigger relation/function/timing/events/update columns/condition/row placement, RLS/effective grants, private bucket, exact four nullable ownership FKs to `auth.users(id)`, and nullable audit actor before its single `COMMIT`. A fresh independently verified connection validates again after the commit attempt. A lost COMMIT response stays `uncertain_or_partial`; confirmed rollback is reported only when fresh readback proves the historical ledger unchanged and all migration effects absent.

`--preflight` runs only read-only transactions and returns sanitized counts for ledger rows, missing prerequisites, target absence, other/active sessions, long transactions, and lock waiters. It performs no bundle or ledger write.

Unrelated duplicate historical names remain allowed. Duplicate versions and version/name conflicts involving the approved 12 or auxiliary identity fail closed. The post-capture `account_deleted_identity_keys` and `account_deleted_storage_keys` tables are correctly excluded from the earlier dynamic trigger topology. Webhook client DML-only revocation remains distinct from the recovery tables' all-privilege revocation.

## Files and frozen fingerprints

| File | SHA-256 |
| --- | --- |
| `scripts/prepare-20260911-production-migrations.mjs` | `178540a6f319c01e2c61696ec99d617189871f6c584c87643974d776c1c8e624` |
| `scripts/testing/production-migration-local-rehearsal.mjs` | `cc849202715f2b4e7a7c5ce538bc8c324ed775fb72c8b6f7848ba3e19b195a72` |
| `tests/unit/production-migration-preparation.test.ts` | `d9000f61c3b8503dff668f10d98c6d7faceb2bc5ac8ae28b2eba7829c0095bad` |
| `tests/unit/production-migration-apply.test.ts` | `078d035b52d0652cc38f0ce778f6b8bcef5406ce466c6d8ff38de568d46586aa` |
| `scripts/lib/supabase-root-2021.crt` | `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7` |
| exact bundle, 215925 bytes | `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab` |

`reviewedMigrationManifest()` revalidated all twelve source hashes exactly as recorded in the plan. `git diff --exit-code HEAD -- src package.json package-lock.json supabase/migrations` exited 0.

## Delegates and integration

- Fresh GPT-5.6 Terra session `01a08f1e-36ae-7522-873e-4c7ad35d0cad` implemented the runner, then built the TLS/PostgreSQL rehearsal. It made no remote call.
- Fresh GPT-5.6 Luna session `01a08f26-7d97-73f1-9827-4aa0c3f79d62` replaced the unit harness with the new transaction/catalog contract. It made no remote call.
- A late CLI queue delivery briefly caused both delegates to target the rehearsal file. Luna was stopped, its unit work was retained, and Terra's rehearsal was restored before final validation. This was a local uncommitted-file coordination event, not a database rollback or execution event.
- Sol integrated types-only function identities, row-level trigger checks, exact FK pairs, trigger chronology exclusions, explicit catalog `text[]` casts, unrelated historical duplicate-name behavior, operational preflight metadata, and confirmed-rollback versus unknown-COMMIT classification.

## Commands and evidence

All final Node commands used `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin` first on `PATH`.

- `node scripts/testing/production-migration-local-rehearsal.mjs`: exit 0. Passed verified local TLS clean install through the new runner, read-only preflight, exact 13-row/full-bundle ledger, three rollback positions, exact task-owned backend bucket race, untrusted CA rejection, hostname rejection, async-driver redaction, and lost-COMMIT uncertainty. Every disposable cluster stopped and was removed.
- `node_modules/.bin/vitest run tests/unit/production-migration-preparation.test.ts tests/unit/production-migration-apply.test.ts --maxWorkers=1`: exit 0, 2 files and 39 tests passed.
- `node --check` on the runner and rehearsal: exit 0.
- scoped ESLint on the runner, rehearsal, preparation test, and apply test: exit 0.
- `git diff --check`, plus new-file no-index whitespace checks for the apply test and CA: exit 0 under their expected status handling.
- bundle/source/file fingerprint command and OpenSSL certificate inspection: exit 0. CA subject/issuer `Supabase Root 2021 CA`, valid through April 26 2031, DER SHA-256 `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`.
- `npx graphify hook-rebuild`: exit 1, `npm error could not determine executable to run`. No graph exists in this worktree and no graph freshness is claimed.

## Remaining risks and release boundary

- The real provider login output, production certificate path, and production catalog remain intentionally untested by this local-only phase. Root must run fresh read-only backup/state/traffic checks and compare the frozen hashes before any apply.
- A lost COMMIT response is deliberately not recoverable as success or rollback by this process. It returns uncertain and must never be retried automatically.
- Global historical migration parity, five newer migrations, the separate application merge conflict, staging/browser/provider/full-E2E gates, protected branches, and application promotion are outside this waiver and remain separate release work.
- The waiver document must record this final fingerprint and an independent approval before the runner may be used against production.

## Fresh Astra review prompt - hard limit 240 seconds

Fresh GPT-6 Astra reviewer: you have a strict 240-second wall-clock limit. In `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`, read only `docs/plans/2026-09-11-production-recovery-verified-transport-plan.md`, this handoff, and the changed implementation/test files plus CA listed in the fingerprint table. Review the frozen diff against R1-R6 and the approved replacement contract. Verify hashes, unchanged 215925-byte bundle and historical SQL, private CLI cwd/env and read-only credential command, exact target/TLS binding, single explicit transaction/COMMIT, auxiliary `[completeBundle]`, full ledger/catalog checks, async error/redaction boundaries, preflight zero writes/metadata, confirmed rollback, unknown COMMIT uncertainty, and deterministic local race cleanup. You may rerun the two focused commands above locally. Do not contact a remote database/provider, acquire credentials, edit files, apply, commit, push, promote, or run no-mistakes. Return `APPROVED` or `CHANGES REQUIRED` with severity and exact file/line blockers. If the 240 seconds expires, return `REVIEW INCOMPLETE`, never approval.
