# Production migration rollout preparation

Owner: root Astra. Akhil feature-cycle planning phase, September 10 local / September 11 UTC 2026.

Repository: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
Keeper: `akhil/backlog-repeat-issues`.
Starting HEAD: `daddb7b5de9910ed3f140ff7d9a63beef48b0547`.

## Outcome and authority

Akhil answered yes to preparing a separately reviewed production migration rollout needed for the PRP-473 release. Proceed with implementation, verification and a precise rollout handoff. His explicit code-shipping authority remains keeper -> main -> staging -> production, without Prakrit integration or no-mistakes.

An additional applicable production rule was inspected this turn: `.cursor/rules/no-production-data-writes.mdc` requires a **new named one-shot script waiver in repo docs**, not general chat authorization. Do not self-approve that waiver. Prepare its exact scope as a draft, then obtain confirmation of the named waiver before any production write. No production apply, ledger repair, protected branch push or provider send is authorized in this execution phase.

Proposed one-shot name: `scripts/prepare-20260911-production-migrations.mjs`.
Draft waiver path: `docs/waivers/2026-09-11-production-recovery-schema.md`.
The script in this phase is preparation/dry-run only; reject `--apply` explicitly. Do not build a generic production administration tool.

## Evidence and scope

Read `2026-09-10-akhil-release-schema-evidence.md` and `2026-09-10-production-migration-risk-inventory.md`. Fresh read-only checks this turn again found four representative production relations absent; staging resolved all four and has every repository migration NAME. No graph exists in this keeper; use area docs instead of a full graph build.

Exactly 12 source files are candidates: `20260907130000_webhook_subscriptions.sql` and the eleven September 7 preservation/recovery files from `20260907214100_preserve_resident_financial_history.sql` through `20260907233000_account_recovery_finish_archival.sql`. Enumerate exact names and SHA-256 in the implementation manifest. Existing historical files must remain byte-identical.

Do not replay the 44 version mismatches. Staging renamed `work_order_human_references` without changing its migration name. Production additionally has bundled history. Ordinary CLI migration repair or a broad `db push --include-all` is not a safe reconciliation.

The SQL inventory correctly distinguishes DDL and stored functions, but several summary risks concern **later application calls**, not migration-time effects. In a genuinely atomic first install, the deleted-identity backfill reads a newly created empty table, so it does not rewrite existing financial rows. Snapshot's all-public-table lock is inside a function and is not invoked by these files. Installing its triggers still acquires relation locks and changes subsequent writes. Verify these distinctions in the handoff.

## Decisions

1. Correct the migration checker to compare nonempty names, not version strings. Same version/different name is missing; same name/different version is applied. Anonymous legacy names remain unresolved, never guessed. Unknown bundles cannot satisfy a missing local migration until a separate explicit equivalence audit: no substring matching, SQL comment stripping, or blanket bundle allowlist. Clarification during implementation: extra applied names alone remain informational/nonfatal, matching the original checker contract; a database may legitimately be ahead of this checkout. Every missing local name still fails.
2. Bind `--target staging|production|dev` to its expected Supabase project in connection host/user before any connection. Unknown or mismatched targets return NOT CHECKED/nonzero. No target remains usable for local developer diagnostics. Preserve exit codes 0/1/2; suppress raw error strings that could disclose credentials. Do not weaken ship preflight or turn missing credentials into success.
3. Prepare a deterministic atomic bundle of the 12 unmodified SQL files with source digests, prerequisite/absence checks, `lock_timeout` 3 seconds and `statement_timeout` 60 seconds. It must not call account deletion/recovery business functions or touch existing listing rows. No backups containing customer data in the workspace. No source credential files.
4. Investigate the installed Supabase 2.117.0 CLI's supported single-migration transactional apply mechanics. A prospective apply must use the versioned migration workflow, not SQL Editor or broad history repair. Preparation may produce a private temporary CLI directory containing exact remote-ledger entries represented as non-executable, already-applied sentinels plus exactly one pending atomic bundle. All generation is deterministic mechanical output of the reviewed script. Do not actually run remote apply. If CLI mechanics cannot be proved, report a planning blocker rather than improvising a new apply architecture.
5. The prospective bundle must record each of the 12 original migration names only when its SQL actually executes in that same transaction; existing ledger rows must not be updated/deleted. CLI may additionally record the bundle name. A retry must refuse partial/changed state and recognize an already-complete install without replay. A fresh ledger read must precede any eventual apply. Fail on original version conflicts.
6. Run a disposable **local PostgreSQL** rehearsal, not Docker or shared staging schema teardown. `initdb`, `pg_ctl`, `psql` are installed. Use a private `mktemp -d` cluster, loopback/socket only, a free dedicated port, and a minimal explicit dependency fixture. Apply the exact 12 files as a transaction, verify roles/grants/RLS/triggers/function signatures, baseline ordinary writes, and rollback on injected failure. Clearly label this a dependency-fixture rehearsal, not a clone of production nor complete account-recovery QA. Stop only the task-owned postgres cluster; preserve evidence and avoid broad cleanup.
7. Read-only staging verification may inspect catalog signatures/grants and a dedicated test fixture may exercise existing recovery functions in a rollback-only transaction if needed. Never drop/recreate staging schema. Do not invoke seed/wipe, sync-prod-to-staging, external storage deletes, Twilio/Resend or cron.

## Ownership and execution

Launch fresh Sol-medium manager. Terra owns checker and focused tests. Luna owns one-shot preparation manifest/script and tests (or swaps ownership if Sol sees better division); no overlapping source writes. Sol owns integration, local PostgreSQL rehearsal, draft waiver and durable handoff. If delegate slots are constrained, run delegates sequentially. The completed Luna SQL inventory is input, not a substitute for execution delegates or fresh Astra review.

Likely files: `scripts/check-migration-parity.mjs`, `tests/unit/migration-parity-check.test.ts`, new one-shot preparation script/helper/test, local rehearsal fixture/script, draft waiver, this phase's handoff. Keep scope compact. Read relevant local Next documentation if touching app/Next files; none are planned. Do not change PRP-473 source, application runtime, migration SQL, package dependencies, existing user changes, or original checkout.

## Acceptance and validation

- Name/version mismatch behavioral tests, duplicate/empty names, genuinely absent migration and unresolved bundle remain nonzero.
- Wrong target and malformed credentials fail before DB I/O; unreachable DB output contains no connection string/password; no-URL remains exit 2.
- Preparation manifest contains exactly 12 pinned file digests, stable order, excludes every protected listing restore; unexpected changes or partial applied states fail closed.
- `--apply` rejected in this phase, no arbitrary path/SQL injection through CLI input, no secret logging, no persistent production connection file.
- Local PostgreSQL exact-SQL install succeeds; injected middle failure leaves no partial objects/ledger; replay/partial-state rejection tested; service-role access positive and anon/authenticated negative; ordinary public/auth/storage fixture writes work after install.
- Focused recovery, financial retention, migration uniqueness, parity and preparation tests, then unit suite (2 workers), lint, typecheck if applicable. Reuse prior full application build/browser evidence only as prior evidence, never claim it tests this new script. New broad E2E and staging/provider acceptance still remain release gates.
- `git diff --check`; attempt required graph rebuild and report installed-tool limitation honestly. No no-mistakes.
- Fresh Astra review after manager handoff, with security and failure-mode emphasis. Fix findings through at most two automatic Sol correction cycles.

## Rollout after this phase

Confirm the named waiver and exact reviewed script before adding/enabling production apply. Review apply behavior freshly. Verify source digests on the approved staging SHA, current backups/read-only catalog/prerequisite state, atomicity and bounded locks. A failed transaction rolls back as a unit; after commit, do not issue generic down migrations or remove guards because live account activity may have begun. Hold code promotion on any failed readback.

Outstanding beyond this preparation: historical bundle equivalence (the fixed conservative checker may still report unresolved production names), full E2E, deployed staging QA, dedicated phone/provider acceptance, production Git release, and TestFlight distribution. No claim that the backlog is completed. PRP-475/476 follow the requested ship-first checkpoint.
