# Verified transport replacement: approved bounded recovery

Astra plan, September 11 2026. Keeper akhil/backlog-repeat-issues, HEAD
10962d8f3734b8424a98d4fa910fcd561943e60a, worktree
/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2.

## Authority and timebox

Akhil answered the explicit question approving amendment of named waiver
2026-09-11-production-recovery-schema to a certificate-verified PostgreSQL
connection for the same unchanged twelve-migration bundle: "okay can we finish
up, do the prod migrations after once more reviewing its safe (<5min) then work
towards having it on prod so that we can test changes on prod."
The initial bounded re-review confirms the existing implementation remains
rejected. Implement the approved transport replacement, not another review of
the known-infeasible CLI project-ref write path. Final independent Astra review
is limited to 240 seconds and must return explicit approval or remaining
blockers, never a false approval when time expires. Implementation and local
tests are not represented as a five-minute operation.

## Fixed scope and changed mechanism

Retain scripts/prepare-20260911-production-migrations.mjs as the named entry.
Keep its preparation API and all twelve historical SQL files unchanged.
Approved buildAtomicBundle bytes remain exactly 215925, SHA256
9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab.
Target remains qahnczmilgptcedaqype ONLY. No generic production API or URL/path
override, other migration, provider/account action, source app change, seed,
role grant operation, history repair, protected branch push, or production
application test write. Root alone performs remote read-only checks and apply
after final review. Subagents operate locally only.

Replace the rejected CLI dry-run/push write orchestration with the existing pg
driver on the exact validated temporary CLI login and pinned official CA,
rejectUnauthorized:true, including hostname verification. Use explicit BEGIN,
SET LOCAL ROLE postgres, unchanged bundle SQL, verification, COMMIT. The CLI
2.117.0 remains only for its read-only db dump --dry-run credential acquisition,
never for db push. No credentials in argv, files, output, or error strings.

The bundle already records twelve source ledger rows. Record the existing
auxiliary identity 20260911010000 / production_recovery_schema in the SAME
transaction, with statements = array containing the COMPLETE unchanged bundle
as ONE element. This supersedes the CLI parser's 121-statement representation;
the full byte comparison is simpler and strict. No existing ledger row changes.
Verify all thirteen rows plus exact unchanged historical ledger before COMMIT
and in a fresh verified connection after COMMIT. The original bundle's advisory
lock, 3s lock timeout, 60s statement timeout, absence and private-bucket guards
remain intact. Never retry COMMIT or the migration. Unknown commit outcome stays
uncertain even if a snapshot is clean. Confirmed server rollback is distinct.

## Required safety corrections

Read the initial apply review R1-R6 and correction-1 handoff. Address all
applicable findings by the simpler replacement, not by retaining dead unsafe
code. Removing CLI db push and its dry-run verdict parser eliminates R2/R5 and
the child-push completion ambiguity; pg COMMIT ambiguity still needs care.

- Acquire credentials from a private minimal config workspace/cwd, not the
  repository. Use a tight child environment allowlist preserving necessary
  OS path/home and approved CLI auth only; no inherited API/project/DB/TLS
  overrides, NODE_OPTIONS, alternate config, or dotenv load. Verify actual
  subprocess construction, exact provider host/project user/port/database and
  CA digest before any DB connection. Do not assign or repurpose HOME.
- Install driver error listeners before connecting. Track asynchronous errors
  without throwing from callbacks. Bound all connection/query/rollback/end and
  filesystem failures; use internal error types/fixed codes, not prefix regex.
  Capture only sanitized outcome metadata. Fresh readback after commit attempt
  must not be skipped by a dead original client or cleanup error.
- Strict acknowledgement parsing remains. --preflight uses only READ ONLY
  transactions and prints sanitized fixed metadata, never applies SQL.
- Validate exact function identities, trigger definitions (placement, function,
  event/timing/columns/conditions), RLS/effective grants, private bucket, four
  nullable ownership FKs to auth.users(id), and nullable audit actor. Export a
  narrow internal catalog reader/validator for the local harness to exercise.
  A local source-derived expected catalog fixture is allowed, with no production
  rows; do not assert only row counts or use placeholder statement contents.
  Compare full original and auxiliary SQL bytes and complete historical ledger.
- Preserve correct account_deleted_identity_keys trigger chronology and the
  immutable webhook DML-only revoke versus recovery ALL-revoke distinction.

## Execution and validation

Fresh Sol-medium manages Terra implementation and Luna disjoint tests/rehearsal
work. Use collaboration if available; otherwise fresh installed Codex CLI
contexts with exact models, as in prior phases. Prefer concise required reads
and bounded output; do not repeat broad research or full old report dumps.
Root continues release readiness checks while implementation runs.

Run focused unit preparation/apply/recovery tests with maxWorkers1, scoped lint,
syntax, diff checks including new files, fingerprints, and actual disposable
PostgreSQL rehearsal THROUGH THE NEW RUNNER. Cover clean install, exact ledger
and catalog checks, unchanged source SQL, preflight zero writes, invalid/partial/
already-installed state, rollback at three positions, bucket conflict/race,
certificate/hostname rejection, async driver errors/redaction, and lost commit
response. Make local race coordination identify the exact task-owned backend,
handle startup/early exit deterministically, and settle children before cleanup.
Do not overlap broad suites on this memory-constrained host. Previous full
unit 1378 files/9681 tests and typecheck passed but are prior evidence.

No UI/source/dependency edits. Do not invoke no-mistakes. Preserve unrelated
untracked user artifacts. Attempt required graph refresh after code changes;
no graph exists in this worktree. No commit/push by delegates.

Write docs/plans/2026-09-11-production-recovery-verified-transport-handoff.md
with exact files, hashes, commands/exit codes, delegate work, remaining risks,
and a 240-second fresh Astra review prompt. Freeze before review. Root will
record final fingerprint in the named waiver, run fresh read-only production
state/backup/traffic checks, apply once only after approval, and record outcome.
Five newer migrations and staging/deployment/full-E2E/provider gates remain
separate and are NOT silently included in this waiver.
