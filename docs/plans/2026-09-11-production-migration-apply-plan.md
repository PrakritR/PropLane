# Approved schema recovery: bounded apply implementation

Root Astra planning. Keeper `akhil/backlog-repeat-issues`, starting HEAD
`10962d8f3734b8424a98d4fa910fcd561943e60a`, worktree
`/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.

## Authority and outcome

Akhil explicitly approved named waiver `2026-09-11-production-recovery-schema`
and its recorded preparation/bundle fingerprints, then requested testing and
promotion. Implement a narrowly gated apply path in the named script, test it,
and return to fresh Astra review BEFORE any production SQL write. Root alone
will execute after review and fresh readback. No subagent remote apply, branch
promotion, provider sends, account operations, or historical repair.

The approved SQL bundle MUST remain exactly 215925 bytes, SHA-256
`9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`.
Do not change any of the twelve historical migration sources or the bundle
builder. The baseline script hash is
`ae442ea1193137a2f2d44dcde67c479675bacfe63cd494dcfb95defac3a17263`;
an apply implementation necessarily changes that script, as anticipated by the
approved waiver's fresh-review gate. Record the final implementation hash.

## Fresh evidence and exclusions

Root's read-only production inspection this turn still finds 163 ledger rows,
all 12 candidate migrations absent, four representative tables absent, all 13
prerequisite relations present, 115 ordinary public tables all with primary
keys, no account lifecycle triggers and no recovery bucket. Four financial
ownership FKs remain CASCADE/non-null; audit actor remains non-null.

Main/staging advanced to `8ce3868b4e5775661956c6c3f36fcb146bfa931a`, production
is `2d1353af42c3a652be6cf8a69640468b453f4cea`. Five new upstream communication
migrations are OUTSIDE this waiver. Do not merge upstream in this phase.
Root will separately investigate release readiness and backup evidence.
Existing duplicate names and historical bundles remain unresolved parity gates.

Read prior rollout plan, prerequisites, risk inventory, correction-1 review,
root validation, named waiver, database environment and ship docs. No Graphify
graph exists; use documentation fallback and report refresh limitations.

## Implementation decisions

1. Preserve no-argument and --ledger-stdin preparation behavior. Add an explicit
   production operation, requiring --apply AND --waiver with the exact name AND
   --bundle-sha256 with the exact approved digest. Reject incomplete, duplicate,
   unknown, extra, path/SQL/target overrides and mixed stdin/apply modes before
   authentication or database I/O. Provide a matching read-only preflight mode
   if helpful, with no ability to apply through default invocations.
2. Keep `scripts/prepare-20260911-production-migrations.mjs` as the named entry
   point. A narrowly named helper under scripts/lib is allowed for connection,
   catalog validation and orchestration. No generic production admin API.
   Do not load .env or store credentials. Use pinned Supabase CLI 2.117.0's
   db dump --dry-run credential pattern from the root-owned read-only diagnostic
   as an input pattern, not its permissive ref-substring test. Validate exact
   host/user/project binding, command success, required fields, fixed port/db,
   and prevent inherited environment credential/endpoint overrides. Capture
   all CLI/driver raw output in memory; print only bounded sanitized metadata.
3. Read fresh ledger/catalog in a bounded READ ONLY transaction with the proper
   local postgres role, never caller-supplied ledger for apply. Verify all
   twelve exact identities absent, clean target objects/bucket absence and
   prerequisites. Generate a brand-new private workspace from that ledger,
   verify fixed bundle digest and all generated files (no extra roles/seed/env).
   Check pinned CLI --dry-run selects ONLY the one exact bundle, seeds/roles
   empty; refuse all other output. Re-read ledger before actual push and refuse
   drift. Do not reuse user-supplied workdirs. Pin project-ref, skip-vault,
   workdir, --yes, never include-all/seed/roles. No retry of failed/uncertain
   apply. A fresh future invocation must inspect state and never replay.
4. After the one push, always perform a new read-only verification even if the
   command failed/connection was lost. Verify all 12 ledger rows and byte-exact
   statements plus auxiliary bundle identity, expected objects/functions,
   enabled lifecycle triggers, private bucket, RLS/grants and financial nullable
   FKs. Classify success, rolled-back/refused, or uncertain/partial. Do not
   silently make successful CLI exit override failed postconditions. No account
   functions, row sampling or test writes in production; local fixture tests
   cover write behavior. Refuse already-complete metadata as permission to replay.
5. Keep approved bundle bytes unchanged. Existing transaction/advisory/bucket
   guards carry in-transaction race protection. Do not add schema-wide backups,
   down migrations, repair, provider sends, or broad deletion. Temporary SQL
   workspaces contain source only; preserve useful failure evidence and remove
   only this task's local PostgreSQL data after verified shutdown.
6. Keep waiver status scope-approved/review-pending until fresh review. Do not
   self-approve review or mark consumed without root execution evidence.

## Delegation and tests

Fresh Sol-medium manages Terra implementation and Luna independent failure-mode
tests in disjoint files. Sol integrates and writes
`docs/plans/2026-09-11-production-migration-apply-handoff.md`. Root continues
read-only upstream/backup/release checks concurrently. No app/dependency edits.

Behavioral tests must prove zero apply calls on invalid flags, wrong project,
bad credentials, ledger partial/conflicts/drift, changed SQL digest, public or
existing bucket, missing prerequisites, unexpected dry-run candidate/seed/role,
failed preflight; single exact pinned push on valid state; post-read failure
not success; lost response/readback handling; already installed never replay;
redacted diagnostics on subprocess and driver errors. Inject dependencies for
hermetic orchestration, not exported CLI bypass knobs.

Run focused preparation/parity/recovery tests, scoped lint, and actual pinned
CLI disposable PostgreSQL rehearsal (unchanged bundle, clean install + exact
rollback failures + concurrent bucket). Earlier full unit/typecheck/lint are
prior evidence; new focused checks and rehearsal required. Root will run broader
release tests after upstream integration if authorized and feasible. Run
git diff --check INCLUDING new files, attempt graph refresh, preserve user-owned
untracked artifacts, and do not invoke no-mistakes.

Fresh Astra reviewer must independently test the apply orchestration and local
CLI behavior, verify unchanged SQL digest and security boundaries, and write
`docs/plans/2026-09-11-production-migration-apply-review.md`. Max two automatic
correction cycles if needed. Root then rechecks approved staging source hashes,
backup/traffic readiness, live target state, and exact dry-run before any apply.
Any failed or uncertain readback blocks code promotion. The five newer migration
omissions, history reconciliation, full E2E and staging/provider QA remain
separate gates, not permission to enlarge this one-shot scope.
