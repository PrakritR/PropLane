# Production migration risk inventory

Date: 2026-09-11

Scope: static SQL audit of the 12 migrations identified by
`docs/plans/2026-09-10-akhil-release-schema-evidence.md` as genuinely absent in
production: the webhook migration plus the 11 account-recovery/
financial-preservation migrations. This is an inventory, not an execution plan
or approval to apply SQL. No database connection, credential loading, DDL,
DML, provider call, source edit, commit, push, or no-mistakes run was performed.

## Executive risk summary

These are not safe to replay as an undifferentiated `db push` batch.

- The webhook migration is mostly additive and isolated, but it creates service-
  role-only credential/journal tables and must be verified against the live
  grants/RLS model before enabling routes.
- The recovery sequence installs security-definer functions, auth and storage
  triggers, broad public-table write guards, retention state machines, dynamic
  SQL, and irreversible erasure paths. It changes behavior for account deletion,
  uploads, financial references, profile identity, and recovery.
- Several files are not rerun-safe despite comments or `ON CONFLICT` clauses:
  plain `CREATE TABLE`, `CREATE FUNCTION`, `CREATE TRIGGER`, `ALTER TABLE ADD
  COLUMN`, constraint replacement, and top-level backfill inserts can fail or
  duplicate side effects on a partial retry.
- Snapshot/capture operations deliberately acquire advisory lock
  `723081447301::bigint`; snapshot also locks every public table in
  `SHARE ROW EXCLUSIVE` mode. This can block ordinary writes and creates a
  meaningful downtime/serialization risk on a busy production database.
- Rollback is not a simple down migration. Functions/triggers can be dropped,
  but retained records, identity tombstones, storage keys, archived payloads,
  profile mutations, auth-user deletion, and uploaded-object state are data
  effects requiring a separately designed recovery procedure.

The schema evidence found production missing the webhook objects and the
recovery/preservation objects, while representative relations exist on
staging. Production remediation therefore needs an explicit migration plan,
lock/traffic window, backups and verification owner. Do not solve the broader
44-version ledger mismatch by replaying all apparently missing versions.

## Dependency and execution order

The minimum dependency order is the repository timestamp order below. The
recovery migrations are coupled and should be treated as one reviewed feature,
not independently cherry-picked:

1. `20260907130000_webhook_subscriptions.sql` - independent webhook tables.
2. `20260907214100_preserve_resident_financial_history.sql` - identity tombstones,
   hashing/detach functions, financial guard trigger installation, and nullable
   `audit_log.actor_user_id`.
3. `20260907221500_preserve_shared_vendor_financial_history.sql` - depends on
   the financial guard/table; rewrites vendor invoice/payout FKs and function.
4. `20260907223000_account_attachment_references.sql` - standalone helper,
   but its scan is intended for the later recovery/storage workflow.
5. `20260907224000_account_recovery_shared_retention.sql` - creates the core
   request, record, hold, dependency tables and coordinator functions.
6. `20260907224500_account_recovery_snapshot.sql` - depends on the core tables,
   identity helpers and existing primary keys/foreign keys.
7. `20260907225000_account_recovery_identity_patches.sql` - depends on core
   recovery tables and financial identity tables/functions.
8. `20260907225500_account_recovery_capture.sql` - depends on every preceding
   recovery function and installs broad DML/delete/auth triggers.
9. `20260907230000_account_recovery_object_generations.sql` - depends on core
   recovery tables and Supabase `storage` objects/buckets.
10. `20260907231000_account_recovery_financial_access_keys.sql` - depends on
    identity tombstones and guard functions; includes a production backfill.
11. `20260907232000_account_recovery_restore.sql` - depends on all recovery,
    object and identity-key functions/tables.
12. `20260907233000_account_recovery_finish_archival.sql` - final archival,
    purge, storage-removal and compaction functions; depends on all prior state.

The webhook file can be separately reviewed and applied, but its route should
not be considered live until its service-role access, event allowlist and
delivery worker are verified.

## Per-migration inventory

### Webhooks

`supabase/migrations/20260907130000_webhook_subscriptions.sql:21-59` creates
`public.webhook_subscriptions` and `public.webhook_deliveries`, with a foreign
key cascade from deliveries to subscriptions at lines 41-44 and due/subscription
indexes at lines 56-59. It has `CREATE TABLE IF NOT EXISTS` and
`CREATE INDEX IF NOT EXISTS`, so the additive objects are relatively retry-safe.

Security is intentional but must be verified: RLS is enabled at lines 61-62,
there are no policies, and DML is revoked from `anon`/`authenticated` at lines
64-70. The secret is encrypted text (`secret_ciphertext`, line 29), while
`payload` is JSONB and `last_error` is stored at lines 45-53. Verify the
service-role route never places names, email, phone or free text in payload or
error fields. Rollback must account for cascade deletion of delivery attempts if
subscriptions are dropped.

### Resident financial preservation

`20260907214100_preserve_resident_financial_history.sql:4-15` creates the
service-role-only `account_deleted_record_identities` table and enables RLS.
Lines 17-61 create identity hashing/detach predicates. The security-definer
`account_preserve_financial_records` at lines 63-99 dynamically selects and
updates arbitrary allowlisted-by-caller table names, inserts identity markers,
and rewrites matching IDs/emails/JSON. The dynamic `FOR UPDATE` query is at
lines 72-76; the update is at lines 93-97.

Lines 101-122 define a trigger guard that blocks reassignment to deleted
identities. Lines 124-128 install triggers on five financial tables. Line 131
drops `NOT NULL` from `audit_log.actor_user_id`. Lines 133-138 revoke/grant
function execution. Risks: the table/function/trigger creation is not
idempotent; dynamic SQL depends on exact columns and stable `id`; existing rows
can be rewritten only when the application invokes the function, but the guard
immediately changes future writes. Verify all five target tables, constraints,
indexes and existing audit rows first.

### Shared vendor financial history

`20260907221500_preserve_shared_vendor_financial_history.sql:3-16` loops over
`vendor_invoices` and `vendor_payouts`, drops matching auth foreign keys, drops
`NOT NULL`, then adds `ON DELETE SET NULL` constraints and a guard trigger.
Constraint names are synthesized at lines 9-12. This is destructive DDL to
constraint definitions and can fail if names/schema differ; it is not rerun
safe. The replacement changes account deletion semantics for both manager and
vendor ownership. Lines 18-59 replace the preservation function and can delete
rows with both owner columns null at lines 53-55. Verify orphan policy, existing
NULL/invalid owner data and application behavior before applying.

### Attachment reference helper

`20260907223000_account_attachment_references.sql:3-22` creates a security-
definer function that scans every public JSON/JSONB column except recovery tables
and the tombstone table, looking for candidate attachment paths. It rejects
non-array or batches over 100 at lines 7-8 and validates `path`/`encoded` at
line 11. The function is service-role-only at lines 24-25. The scan can be
expensive as table/JSON volume grows, but it has no top-level DML. Function
creation is not `CREATE OR REPLACE`, so retry requires object-existence handling.

### Core recovery coordinator

`20260907224000_account_recovery_shared_retention.sql:3-67` creates four core
tables and indexes. They have no `IF NOT EXISTS`; a partial application cannot
be safely rerun. `account_recovery_open` and `account_recovery_add_hold` use the
global advisory lock at lines 69-118, validate portal/role and retain service-
only state. `account_recovery_choose` transitions to `recovering` or `purging`
at lines 133-150. Expiry claims use `FOR UPDATE SKIP LOCKED` but still take the
global lock at lines 152-166.

`account_recovery_erase_records` at lines 168-191 permanently sets payload and
row keys null and marks records erased, recursively through dependencies. It
cannot be rolled back after transaction commit without separate retained data.
Lines 202-212 enable RLS, revoke client access and grant service role, then
revoke/grant all recovery functions. Verify migration transaction behavior and
service-role route compatibility before enabling calls.

### Snapshot

`20260907224500_account_recovery_snapshot.sql:33-116` dynamically discovers
public tables and rules, takes the global advisory lock at line 38, then locks
every non-recovery public table in `SHARE ROW EXCLUSIVE` mode at lines 41-45.
This is the largest immediate lock/downtime risk: it can block concurrent DML
across the public schema for the duration of tenant scanning and dependency
construction. It uses dynamic `FOR UPDATE` scans at lines 50-51 and inserts
records/holds/dependencies, with recursion/dependency loops through lines
86-116. It must be tested on staging with production-sized row counts and a
lock-timeout/statement-timeout policy agreed in advance.

### Identity patches

`20260907225000_account_recovery_identity_patches.sql:40-86` uses a global lock,
row locks and dynamic `FOR UPDATE` reads (lines 45-54), then rewrites live rows,
identity tombstones and JSON identity fields (lines 56-85). For financial
records it inserts identity keys and can delete unowned vendor invoice/payout
rows at lines 66-84. This is irreversible application data mutation and must
have a tested per-record audit/rollback story. Function creation and grants at
lines 88-93 are not rerun-safe.

### Capture and write guards

`20260907225500_account_recovery_capture.sql:1` adds `snapshot_complete` without
`IF NOT EXISTS`. `account_recovery_begin` at lines 3-28 invokes open, snapshot
and identity detachment, then marks the request complete.

The delete capture trigger at lines 32-46 archives deleted rows. The write guard
at lines 48-127 rejects writes to retained records, blocks new children and
identity changes, and fails fast with SQLSTATE `40001` when it cannot acquire a
shared advisory lock (lines 55-60). Lines 129-138 dynamically add two triggers
to every non-recovery public table. Line 155 adds an auth.users email/delete
trigger. This is a broad behavior change with high compatibility risk: every
table must have a valid primary-key shape for `account_recovery_row_key`, and
ordinary writes can start returning retryable errors during account lifecycle
transitions. Verify trigger counts, excluded tables, nested trigger behavior and
all existing write paths before production activation.

### Object generations and storage

`20260907230000_account_recovery_object_generations.sql:3` inserts a private
`account-recovery` storage bucket. It creates key/tombstone/object/hold/link
tables at lines 4-43, with service-role RLS grants at lines 160-169. The object
registration function at lines 63-105 validates bucket/path allowlists, creates
or rotates generations, records opaque retirement keys, and dynamically links
stored payload references. It can move an active generation into copying at
lines 87-93. The progress function at lines 107-119 marks source removal and
retirement.

The storage guard at lines 129-158 runs before every storage object insert/update,
blocks reuse of retired keys and blocks uploads associated with active recovery
requests. This can affect upload traffic globally. Verify storage trigger
ordering, service-role bypass assumptions, bucket policies, and existing object
metadata before enabling. Bucket creation is `ON CONFLICT` safe, but tables,
functions and trigger creation are not.

### Financial access-key backfill

`20260907231000_account_recovery_financial_access_keys.sql:3-15` creates a
service-role-only key table and performs a top-level backfill from every existing
`account_deleted_record_identities` row. This is the first explicit production
backfill in the set. It may be large and must be sized/indexed and monitored.
Lines 17-42 replace the financial guard; lines 44-86 replace the preservation
function, add keys during each preservation operation, dynamically update rows,
and delete unowned vendor invoice/payout rows at lines 80-81. It depends on the
earlier tables/functions and is not safe to run before them. Verify backfill
counts and uniqueness before/after, with a backup or compensating procedure.

### Restore

`20260907232000_account_recovery_restore.sql:1-60` rewrites public asset URLs,
locks and conditionally restores identity patches. It deletes matching identity
keys at lines 50-53 and dynamically updates live rows at lines 54-59. A mismatch
fails closed by consuming the patch without overwriting a surviving owner (lines
36-43), which is desirable but must be covered in staging.

`account_recovery_restore_available` at lines 64-153 takes the global lock,
validates auth identity, can recreate `profiles` and `profile_roles` at lines
78-81, dynamically inserts retained rows at lines 88-120, performs deferred FK
updates at lines 126-132, activates storage objects at lines 134-143, and marks
requests restored at lines 148-151. Dynamic inserts may hit current schema,
constraint, trigger or uniqueness differences. It has no clean inverse after
publication; test restore with empty, partial, changed-owner, missing-parent and
file-reference cases.

### Finish archival and purge

`20260907233000_account_recovery_finish_archival.sql:1-26` transitions retained
accounts, deletes selected `profile_roles`/`profiles`, edits `auth.users` metadata,
and recursively marks archived records erased with payload/key removal at lines
20-25. Lines 28-57 purge object generations and insert deleted storage keys.
Lines 59-76 can delete `auth.users` when the account has no remaining roles or
active recovery requests (line 72), then discards request identity data.

Lines 85-105 prepare private-file removal and change object state; lines 107-125
compact terminal recovery data by deleting holds and payloads. These are
irreversible destructive effects and must be gated by exact state/claim checks,
with an operator-visible audit trail and tested retry semantics.

## Verification gates before any production application

1. Reconcile the migration sequence against actual production catalogs and
   migration history. Do not use version-name parity alone because the schema
   evidence documents bundled/renamed historical migrations.
2. Apply and validate on staging first, using representative account deletion,
   financial-reference, shared vendor invoice/payout, attachment, auth identity,
   and recovery/restore fixtures. Confirm staging relations, indexes, grants,
   RLS, triggers, storage bucket/policies and function signatures.
3. Run a transaction/lock rehearsal with realistic row counts. Capture lock
   wait durations for the snapshot all-table lock and advisory lock; set an
   explicit maintenance/traffic window and statement/lock timeouts.
4. Verify trigger installation inventory before enabling lifecycle writes:
   every intended public table exactly once, no recovery tables recursively
   guarded, auth.users guarded once, storage.objects guarded once.
5. Verify service-role-only access using negative anon/authenticated probes and
   positive route-level service-role calls. Never grant client DML to recovery,
   tombstone, object or webhook secret tables.
6. Verify counts and hashes for the financial identity-key backfill, with an
   export/backup or compensating procedure before destructive operations.
7. Exercise failure/retry paths: SQLSTATE `40001`, duplicate begin, expired
   challenge, changed email, changed owner, missing parent, FK cycle, duplicate
   object generation, stale cleanup worker, and repeated terminal compaction.
8. Only after code, staging QA, schema review and migration parity sign-off,
   apply the narrowly selected production migration set. Record exact files,
   checksums, start/end times, lock metrics, row counts and verification output.

## Rollback posture

There is no safe generic rollback. A failed transactional migration may roll back
its DDL, but committed application effects from later worker calls are not
reversed by dropping functions/triggers. In particular, erased recovery payloads,
deleted auth users, detached financial identities, deleted unowned invoices,
retired storage keys and changed object generations require explicit compensating
procedures. Keep the old application paths disabled or fail-closed until object
and grant verification passes; do not remove guards after partial execution
without understanding retained state.

## Blockers

- Production omissions are confirmed, but the exact production remediation scope
  and operator authority must be recorded separately from Akhil's code-shipping
  authorization.
- The migration files contain non-idempotent DDL and destructive/data-mutating
  functions; direct replay of all 12 without staging rehearsal is unsafe.
- Snapshot and lifecycle triggers introduce global lock and write-path behavior
  that needs a traffic window and rollback/compensation plan.
- Full staging QA, schema verification after apply, and application-level
  recovery/attachment/provider acceptance remain outstanding.
