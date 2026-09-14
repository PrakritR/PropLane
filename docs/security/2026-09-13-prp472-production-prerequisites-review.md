# PRP-472 prospective production prerequisite review

Date: 2026-09-13. Scope: four existing migrations only; no database calls, source edits, Git changes, provider sends, or production mutations performed by this reviewer. Root supplied read-only production snapshots. This is not the final PRP-470/472 feature review or approval to apply SQL.

## Decision

The four gaps are real. The inspected production catalog and recorded SQL show no later definition that these files would overwrite incorrectly. **The follow-up recovery trace below identifies a concrete account-deletion failure if the new controls table lacks the existing recovery triggers. Do not approve the four-file batch unchanged until that condition is resolved.** Do not treat this assessment as permission to push all pending migrations.

The material scope expansion is tour reminders: it alters a shared queue and resolver, adds an automation trigger and control table, and contains a data backfill. The current production snapshot contains **21 reminders** (booking 8, task 9, tour 4), **zero empty recipients**, **zero incompatible lead times**, and **zero enabled automation rows requiring backfill**. Those counts are observations, not a guarantee about apply time.

## Exact reviewed inputs

All paths below are under `supabase/migrations/`.

| File | SHA-256 |
| --- | --- |
| `20260912210000_atomic_conversation_house_assignment.sql` | `cdc12b5d8af2d286742e7053d78cd5be0e6a22a2cbc606b2df53ef9b82e3d08f` |
| `20260912220000_tour_interest_reminders.sql` | `5937d23cca3c921128409e7ec7b0e649f11c69b40f7c2898fc575e100b3a0f34` |
| `20260912230000_vendor_directory_private_fields.sql` | `ef936eba8f457d310e7173519d01cbef88205291361ba48d2b945b107311050e` |
| `20260912233000_atomic_inbox_folder_changes.sql` | `36151c07f984c0bf0b4edb6ab5304e160ff39c8a4237e428cdab4210c0794474` |

Baseline remote main/staging/production in the root inventory: `75d711053085e340072c605bcb96eaa9416ef87e`. Re-pin the final candidate before apply. Root evidence is in `/private/tmp/axis-inbox-release/production-before.json`, `production-prerequisites.json`, `production-preflight.json`, `production-preflight-extra.json`, and `staging-before.json`. These private files include catalog/ledger SQL, not mailbox content. Their existence is not a full data backup.

The graphify query was attempted first and failed because its CLI sought missing `graphify-out/graph.json`; no graph was rebuilt or mutated. Assessment used exact migrations, area contracts, call sites, and recorded database evidence.

## Effects and dependencies

**21:00 house assignment.** Adds `conversation_house_access_revision(uuid)` and `replace_conversation_houses(uuid,uuid,text,text[],text[],jsonb,text)`. Both are currently absent. Apply itself changes no house, tag, profile, or listing row. Runtime replacement checks the access revision and exact existing tags, validates next properties against the supplied owner, and replaces tags transactionally. Functions deny PUBLIC/anon/authenticated execution and grant service_role. The TypeScript resolver remains the authorization source; a revision is not an independent permission grant. Required existing relations are `account_link_invites`, `manager_property_records`, `profiles`, and `manager_sms_conversation_houses`. Runtime SHARE locks on the first three and SHARE ROW EXCLUSIVE on tags can delay unrelated writes. Preserve this as an operational limitation, especially during account lifecycle operations. Sources: migration lines 4-55; `src/lib/sms/conversation-houses.server.ts:62`; `tests/unit/sms-conversation-house-assignment-sql.test.ts`.

**22:00 tour reminders.** Adds nullable `recipient_phone`; relaxes email NOT NULL but adds a check requiring a nonempty email or valid international phone for `tour_interest`; replaces kind/lead constraints; adds a partial thread index; adds `tour_interest_enabled_at`, its stamping trigger, and the explicit enabled-row UPDATE. Creates `manager_tour_followup_controls` with auth-user cascade FK, compound PK, RLS, no ordinary client privileges, service_role privileges. Adds cancellation/archive/edit and submission-boundary functions, and replaces `resolve_reminder` to accept `cancelled` while preserving the existing worker lease/status compare-and-set. These SQL functions do not call providers. Runtime workers can use the capability after installation; default tour interest settings are disabled (`src/lib/reminders/rules.ts:348`). The cutoff prevents pre-enable responses from becoming new reminders (`src/lib/reminders/subjects/tour-interest.server.ts:55`). This migration depends on 21:00 plus existing queue, outbox, SMS message, automation, and auth tables. Outbox snapshot confirms required columns, unrestricted text `purpose`, `(manager_user_id,dedupe_key)` uniqueness, and all statuses used by the new functions.

**23:00 vendor directory privacy.** Drops exactly the existing `manager_vendor_records_vendor_read` SELECT policy, currently `(vendor_user_id = auth.uid())` and the only policy reported for that table. With RLS enabled, ordinary vendor direct reads cease to expose the manager's full row_data. No directory data is removed, and service routes remain available. Confirm actual RLS/table privileges and the staged authorized-read smoke below. Do not silently restore the policy to fix a reader: that would restore access to private fields. Sources: `docs/agents/vendor-portal.md:88`, `src/app/api/vendor/documents/route.ts:45`, `src/lib/vendor-own-record.ts:6`, `src/lib/vendor-catalog-projection.ts:3`.

**23:30 inbox folders.** Adds two currently absent service-only functions. The generic function updates supplied IDs within a supplied scope after a cardinality check; it relies on the route to derive and authorize those IDs. The SMS wrapper additionally requires owner and manager scope and calls the 22:00 follow-up function before updating folders in the same transaction. Archive sets trash, previousFolder and unread false; restore changes folder/removes previousFolder. Existing bodies/attachments are preserved by JSON field updates. No mailbox rows change during migration apply. Required order: 21:00 -> 22:00 -> 23:30; 23:00 is independent. Sources: `src/app/api/portal-inbox-threads/route.ts:195`, `src/app/api/manager/tour-follow-ups/route.ts:74`.

## Supersession audit

All 212 production ledger entries were searched by affected function/constraint/policy symbols, including bundled statements and remote-only migration names. The sole existing affected function is `resolve_reminder`, owner postgres, SECURITY DEFINER, search_path `public, pg_temp`, ACL postgres/service_role. Its live body matches the old resolver; the prospective change adds only the cancelled outcome to its allowed status set.

Production-only `20260906214710_inspection_reminder_kinds_final` is significant: it repeats the 14 kinds in `20260906211532_inspection_reminder_kinds`. The prospective migration preserves all 14 and adds tour_interest. It does not replace the newer recipient-role constraint that permits `team`, nor the reminder status constraint. Existing lead constraint is 5..43200; the replacement preserves that and adds only tour_interest/-1440. No existing recipient-check or thread index was reported. The vendor policy has not been superseded by another policy. No later ledger statement recreates or replaces the seven new function names.

Production-only `production_recovery_schema` includes the account-recovery machinery. The automation table has `account_recovery_write_guard` BEFORE writes and `account_recovery_capture_delete` AFTER deletes. The prospective timestamp trigger does not replace either. The guard may reject a nonzero backfill on retained accounts or during lifecycle transitions. Never bypass or disable it. At the captured zero-row backfill, no row trigger executes.

## Residual risks and unresolved evidence

1. No live DDL rehearsal or production behavior probe was performed. Staging ledger presence alone does not certify live function bodies, ACLs, or application behavior. Root must capture/compare staged definitions and run the bounded smoke.
2. DDL obtains locks and validates existing rows. The current table is small, but apply must have short lock and statement timeouts and stop on contention or changed preconditions. Do not retry an unknown partial batch without rereading ledger/catalog.
3. The folder functions do not lock their initial membership count or assert final updated cardinality. They are atomic transactions, but are not a full concurrent deletion/owner-transfer compare-and-set. The generic function does not independently rederive caller identity; only service execution plus the authorized route makes it safe. Invalid/null direct inputs also receive uneven SQL-level handling. Do not broaden their grants or claim this review proves every concurrent ownership race.
4. `manager_tour_followup_controls` is classified in `src/lib/auth/account-purge-manifest.ts:487`, but 22:00 does not add account-recovery guard/capture triggers. The older recovery installer only covered tables existing at install time. Follow-up tracing below establishes a concrete deletion failure, not merely missing general lifecycle assurance, if catalog checks confirm no automatic trigger installation. Do not alter historical SQL or perform retention-record repairs implicitly.
5. Automatic messages are a possible later runtime effect of the new capability, even though the SQL sends nothing and no manager is enabled in the snapshot. This review does not authorize enabling automations, submitting outbox rows, running dispatch workers manually, or changing provider flags.

## Exact remaining read-only queries

Run with explicit target `qahnczmilgptcedaqype` through the established read-only path; repeat catalog counterparts on staging `xwszcafaontidfgznlxd`. Keep full definitions private. Do not invoke the mutation functions as a production test.

```sql
select c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relacl
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
 ('manager_vendor_records','manager_automation_settings','manager_tour_followup_controls');

select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)
from pg_trigger t join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and not t.tgisinternal
and c.relname in ('manager_automation_settings','manager_tour_followup_controls');

select evtname,evtevent,evtenabled,evtfoid::regprocedure
from pg_event_trigger;

select pg_get_functiondef('public.account_recovery_write_guard()'::regprocedure);

select table_name,column_name,udt_name,is_nullable
from information_schema.columns where table_schema='public' and table_name in
 ('account_link_invites','manager_property_records','profiles',
  'manager_sms_conversation_houses','manager_sms_messages','manager_automation_settings')
order by table_name,ordinal_position;

select count(*) as total,
 count(*) filter(where nullif(trim(recipient_email),'') is null) as invalid_recipient,
 count(*) filter(where kind not in
 ('tour','tour_interest','task','service_order','work_order','booking','application',
  'application_manager','application_post_tour','lease','lease_manager','payment_manager',
  'outgoing_payment','inspection','inspection_manager')) as invalid_kind,
 count(*) filter(where not (lead_minutes between 5 and 43200 or
   (kind='tour_interest' and lead_minutes=-1440))) as invalid_lead
from public.portal_reminder_records;

select count(*) as enabled_backfill_rows from public.manager_automation_settings
where row_data #>> '{reminderRules,rules,tour_interest,enabled}'='true';
```

The recipient query is intentionally pre-apply: production currently has no phone column, so newly added phone values would all be null. Also recapture the full ledger, affected function definitions/owners/config/ACLs, queue constraints/indexes, automation triggers, and vendor policies already captured by root. If enabled rows become nonzero, stop the zero-row plan and inspect the exact affected rows/recovery state privately before revising scope.

## Backup and bounded apply proposal

Preserve mode-0600 catalog/ledger snapshots in the mode-0700 private directory, with hashes and explicit project ref/time. Include original `resolve_reminder` definition/ACL, all replaced constraint definitions, index/column metadata, vendor policy and RLS state, and all existing automation triggers. Preserve a consistent export of automation rows selected by the backfill, including their keys and full row_data, even if the result is an empty set. For a nonzero backfill, a mere count or schema dump is not a sufficient backup. Preserve a verified database recovery checkpoint before the authorized change; do not perform any restore as QA.

The exact apply artifact must fail closed if any reviewed catalog/ledger precondition changes. Prefer the observed zero-enabled-row bound for this release; guard it in the apply transaction immediately before the UPDATE under the DDL-acquired table lock. Any wrapper/preflight SQL added to achieve that must itself be reviewed and rehearsed on an isolated test database while preserving the four source hashes. Do not relabel remote migration history or include all local historical files.

After final candidate/staging verification and authorization: create the isolated migration directory from actual remote recorded history plus only these four byte-identical files (and the separately reviewed read RPC if explicitly included in the same approved inventory). Use the repository CLI push path, assert the project ref, and prove the dry run contains exactly that allowlist. Apply in timestamp order with reviewed bounded timeouts and fail-on-error semantics. Do not assume multiple migrations are one all-or-nothing transaction; on failure inspect committed versions before deciding next action. No generic history repair, seeds, resets, listing updates, recovery bypass, or provider action.

Post-apply: re-read exact ledger/name/statement evidence, function bodies and effective anon/authenticated/service privileges, validated constraints, index validity, nullable columns, enabled cutoff values, trigger/RLS/ACL state, and vendor policy absence. Preserve all unrelated constraints and policies. Verify unchanged reminder count/kinds and unchanged existing fields as far as concurrent normal writes allow. Archive/restore runtime QA belongs to isolated staging fixtures, not real production messages. Roll forward with a reviewed corrective migration if needed; do not automatically restore broad vendor reads or drop columns/tables that may now hold valid records.

## Minimal staged acceptance and authorization boundary

On staging, use an isolated manager/vendor and one manager-owned directory row linked by exact vendor_user_id. Give it harmless sentinel notes and insuranceProvider; no blobs or real contacts. Vendor-authenticated `GET /api/vendor/documents` must return 200, `linked:true`, the insurance sentinel, and no notes sentinel. Direct vendor/anonymous PostgREST SELECT of that exact directory ID must disclose no row. The manager's authorized directory route must still read its own row. `GET /api/vendor/availability` is supplementary; its vendor-self path does not exercise the directory read, so it cannot replace the documents check.

Use existing focused tests for house assignment and tour SQL (`sms-conversation-house-assignment-sql.test.ts`, `tour-interest-reminder-sql.test.ts`), folder route tests, and real staged synthetic archive/restore including notice grouping and unrelated-body preservation. Do not run the PGlite test truncation statements against any remote DB. This reviewer read those tests but did not execute them; root owns serial test execution and staging evidence.

The existing ship request covers PRP-470/472, not silent application of four older production gaps. Root should finish the candidate and staged acceptance first, then obtain one explicit bounded authorization naming these four migrations, the live project, shared reminder changes/backfill bound, and vendor policy removal. That authorization must not be construed as permission to enable messaging, mutate locked listings, change account-recovery semantics, or repair unrelated history. If the user declines, keep the feature's separate schema path explicit and report any dependent archive/house/tour functionality remaining unavailable.

## Follow-up: recovery classification and concrete failure

The controls are **not explicitly exempt or disposable** under the implemented policy. `accountArchiveRules()` maps the phase-2 manager ownership rule to `ids: ["manager_user_id"]` and `recover:true`. `ACCOUNT_RECOVERY_NEVER_RESTORE` excludes queued reminders/outbox, scheduled messages, and automation settings, but not controls. `ACCOUNT_RECOVERABLE_TABLES` therefore includes controls. This is distinct from settings that must not restart automation after recovery. The control is also not in SQL's `account_recovery_recreatable` allowlist. Sources: `src/lib/auth/account-recovery-policy.ts:13`, `:64`, `:90`; `supabase/migrations/20260907224000_account_recovery_shared_retention.sql:47`.

Exact user-visible failure sequence, assuming the table has neither recovery trigger:

1. A manager archives or restores an SMS conversation. `change_tour_interest_followup` inserts/updates a controls row for either action, even when no reminder exists and tour automation is disabled.
2. The manager deletes their manager portal/account. `schedulePortalAccountDeletion` sends the generated manifest to `account_recovery_begin`; the snapshot selects the controls row and creates a delete hold with `archived=false` (`account-recovery.server.ts:73`; `20260907224500_account_recovery_snapshot.sql:44`).
3. `runManifestPurge` deletes the controls row in phase 2 (`purge-portal-account-data.ts:100`). Without `account_recovery_capture_delete`, nothing changes the held record to `archived=true`.
4. `account_recovery_finish_archival` rejects the deletion with **Personal record cleanup incomplete**, leaving the request in `archiving` after other cleanup has already happened. The same check exists in production's recorded `production_recovery_schema`, so this is not an obsolete local function. An ordinary retry deletes no controls row, cannot fire capture retroactively, and repeats the failure (`20260907233000_account_recovery_finish_archival.sql:9`).

This is a deterministic source-derived failure; the reviewer has not executed an account deletion on staging or production. Root's staging trigger/event-trigger query determines whether that schema condition actually holds. The BEFORE guard is also necessary to freeze writes against the snapshot and prevent mutations/recreation while held; installing only the AFTER trigger would address the immediate deletion failure but leave recovery consistency incomplete.

The smallest additive correction for this defect reuses the existing two functions, without changing restore policy:

```sql
do $$
begin
  if to_regclass('public.manager_tour_followup_controls') is null
    or to_regprocedure('public.account_recovery_write_guard()') is null
    or to_regprocedure('public.account_recovery_capture_delete()') is null
  then raise exception 'Required follow-up/recovery schema missing'; end if;
end $$;
drop trigger if exists account_recovery_write_guard on public.manager_tour_followup_controls;
create trigger account_recovery_write_guard before insert or update or delete
  on public.manager_tour_followup_controls for each row
  execute function public.account_recovery_write_guard();
drop trigger if exists account_recovery_capture_delete on public.manager_tour_followup_controls;
create trigger account_recovery_capture_delete after delete
  on public.manager_tour_followup_controls for each row
  execute function public.account_recovery_capture_delete();
```

This is a proposal for a **separate, reviewed, tested additive migration**, not executed SQL or an instruction to overwrite existing trigger drift. Preflight must compare any existing same-name triggers and stop on an unexpected definition; record their actual state before apply. Test the existing recovery functions with one controls row: snapshot -> ordinary delete -> archived=true -> successful finish; reject mutation while held; restore the captured archived flag and timestamp on Recover. Use an isolated SQL fixture to avoid billing/provider side effects in account-deletion routes. Before installing on staging, query aggregate holds for this table where the request is archiving and record is not archived. Existing stuck holds need separately scoped diagnosis; adding a trigger does not retroactively mark them archived.

Do not solve the failure by adding the table to NEVER_RESTORE: nonrecoverable delete holds also require capture to complete. Do not add it to recreatable automatically either. Starting fresh may legitimately need a new control with the same owner/conversation compound key, and the current recreatable policy does not permit that after an erased generation; that is a distinct product-policy question shared with other deterministic-key retained data. It does not justify bypassing capture or broadening this narrowly identified remedy.
