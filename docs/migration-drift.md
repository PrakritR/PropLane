# Migration drift on the dev/test Supabase project

> Status: **open operational issue**, recorded 2026-06-28.
> Update 2026-06-29: remediation is **knowingly deferred** — do not run the repair
> or `db:push` yet. The migration file is committed and correct; it is simply not
> applied. See [Impact](#impact) for the runtime consequence while deferred.
> Update 2026-08-25: the SMS development blocker was narrowly unblocked on the
> shared dev/test project. An isolated temporary CLI workdir applied and recorded
> only `20260717120000_sms_consent_delivery.sql`,
> `20260725120000_manager_sms_numbers.sql`, and
> `20260825120000_sms_control_plane.sql`. The control plane was verified with
> `sms_runtime_config.mode = 'paused'`, no manager number was created, and
> anon/authenticated access remains denied. The broader migration-history drift
> is still open; normal `db:push`, `db:baseline`, and broad repair remain unsafe.
> Update 2026-08-26: the same isolated-workdir pattern applied only
> `20260826130000_manager_sms_contacts.sql` to prop-lane test
> (`emstjswhotsnyksqhqyf`) so Add phone contact can persist labels. Production
> was not touched.

## Summary

The shared dev/test Supabase project (`emstjswhotsnyksqhqyf`) has **migration
history drift**: several committed migration files under `supabase/migrations/`
describe schema objects that already exist on the remote database, but the
remote `supabase_migrations.schema_migrations` table does not have them recorded
as applied. As a result a normal `npm run db:push` refuses to apply only the
newest migration and instead reports older, "out of order" local files.

This blocks applying new migrations through the standard flow until the history
is reconciled.

The 2026-08-25 SMS exception did not reconcile the full history. It used remote
history placeholders in a temporary workdir plus only the three real SMS files,
and proceeded only after `db push --include-all --dry-run` listed exactly those
three versions. Do not copy that exception into routine schema work: use it only
for a reviewed, dependency-complete, additive migration batch against the
explicit dev/test project ref.

## How it surfaced

Adding `supabase/migrations/20260701120000_portal_service_request_records.sql`
(the Services server-persistence migration) and running a dry run:

```
$ npx supabase db push --linked --dry-run
Found local migration files to be inserted before the last migration on remote database.
Rerun the command with --include-all flag to apply these migrations:
  supabase/migrations/20260624120000_screening_orders.sql
  supabase/migrations/20260624140000_manager_vendor_records.sql
  supabase/migrations/20260624150000_cosigner_submission_records.sql
```

`--include-all` would replay **12** migrations, including ones whose tables are
already live with data (`manager_vendor_records`, `ledger_entries`,
`vendor_tax_profiles`, `scheduled_inbox_messages`, …) and at least one
`alter table public.profiles ...` statement. Most files use
`create table if not exists` / `create index if not exists` and are idempotent,
but the replay is broad and touches shared schema, so it should not be run blind.

## Why it happens

Schema was applied to the remote at some point through a path other than
`supabase db push` (e.g. the SQL editor, `db:apply-sql`, or an out-of-order
push), so the objects exist but their migration rows were never inserted. New,
correctly-dated migrations then sort *after* these unrecorded files, and the CLI
treats the unrecorded files as pending work that must be force-included.

## Impact

- New migrations cannot be shipped with a plain `npm run db:push`.
- Specifically, `portal_service_request_records` is **not yet applied**, so the
  Services feature's server persistence and the agent tool `list_service_requests`
  will error at runtime (relation does not exist) until the table is created.

> **Deferred on purpose (2026-06-29).** This remediation has not been run; the
> service-requests server-persistence feature is therefore non-functional at
> runtime by design until someone follows [Recommended remediation](#recommended-remediation)
> against dev/test. This is tracked, not forgotten — the migration file stays in
> the tree so it ships once the history is reconciled.

## Recommended remediation

Reconcile the migration history so the already-applied files are marked applied,
then push only the genuinely new migration. Do this against **dev/test only**
(never production — see [`database-environments.md`](./database-environments.md)).

1. Inspect the current state:
   ```
   npm run db:status        # supabase migration list --linked
   ```
2. Mark the already-applied historical migrations as applied (repair), e.g.:
   ```
   supabase migration repair --status applied 20260624120000 20260624140000 20260624150000 ...
   ```
   `npm run db:baseline` repairs the full local set in one shot; use it only if
   every listed file is truly already present on remote.
3. Re-run the dry run to confirm only the intended new migration remains:
   ```
   npx supabase db push --linked --dry-run
   ```
4. Apply:
   ```
   npm run db:push
   ```

If you instead choose `npx supabase db push --include-all`, first confirm every
replayed file is idempotent (notably any `alter table` without
`if not exists`), because a non-idempotent statement will fail mid-batch and can
leave the history partially advanced.

## Prevention

- Apply all schema changes exclusively through `supabase db push` (the
  `db:push` script), never the SQL editor or ad-hoc `db:apply-sql`.
- Keep migration filenames strictly increasing by timestamp.
- After any manual remote change, immediately `supabase migration repair` so the
  history stays in sync.
