-- One shot, 2026-10-30 auth release. MANDATORY release step: run this AFTER the 16 migrations
-- (20261030141000..20261030145200) and BEFORE the code deploy, on staging first, then production.
--
-- Why it exists
--   The release scopes every resident read on `resident_user_id` (services) and
--   `row_data.residentUserId` (applications). 20261030144600 adds those service columns with no
--   backfill, and its `sync_resident_service_subject` trigger raises
--   'Existing service subject cannot be assigned' on any UPDATE that would set one -- so no later
--   application write can repair a pre-release row. Without this script an existing resident signs
--   in to an empty service history, un-cancellable open requests, an empty "My applications", and
--   nav stage `pre_approval` with Lease / Payments / Documents padlocked.
--
-- What it binds, and what it refuses
--   A row is bound ONLY to an Auth subject the database can prove on its own:
--     * exactly one `auth.users` row with `email_confirmed_at not null` whose lower(email) matches
--       the row's resident email -- an unconfirmed mailbox, no match, or two matches binds nothing;
--     * that user holds a `profile_roles` 'resident' row;
--     * for a SERVICE row, that same subject is additionally bound (by step A, in this very
--       transaction) to an application, or carried by a lease, under the SAME manager and the SAME
--       property as the service row.
--   Every UPDATE is guarded on the subject still being null, so a re-run is a no-op and a row a
--   person has already bound by signing in is never overwritten.
--
-- Steps
--   1. Back up the three tables first (plain `pg_dump` of the schema is enough; nothing here deletes):
--        pg_dump "$DATABASE_URL" -t public.manager_application_records \
--          -t public.portal_work_order_records -t public.portal_service_request_records \
--          > backup-resident-subjects-$(date -u +%Y%m%dT%H%M%SZ).sql
--   2. DRY RUN: run this file with the final `commit;` replaced by `rollback;` (or paste it into a
--      session and type `rollback;` yourself). Read the PREVIEW counts and the VERIFICATION counts;
--      nothing is kept.
--   3. APPLY: run it as written. It is one transaction: a failure anywhere leaves the database
--      untouched and the guard trigger enabled.
--
-- The guard trigger is disabled for the two SERVICE tables only, inside the transaction, and
-- re-enabled before commit. `manager_application_records` has no such trigger and is never altered.
-- With the trigger off, the UPDATE must write `row_data.residentUserId` itself -- the trigger is
-- normally what keeps the column and the payload in step.

begin;

-- Serialize against the account-lifecycle advisory lock the release's own functions take, so a
-- concurrent delete/recovery cannot move an Auth row out from under this backfill.
select pg_advisory_xact_lock(723081447301::bigint);

-- The one definition of "a subject this database can prove from an email": exactly one confirmed
-- Auth user with that address, holding the resident role.
create temporary table _unique_resident_subject on commit drop as
select lower(btrim(u.email)) as email, min(u.id) as resident_user_id
from auth.users u
join public.profile_roles r on r.user_id = u.id and r.role = 'resident'
where u.email is not null
  and btrim(u.email) <> ''
  and u.email_confirmed_at is not null
  and u.deleted_at is null
group by lower(btrim(u.email))
having count(distinct u.id) = 1;

create unique index on _unique_resident_subject (email);

-- =====================================================================================
-- PREVIEW
-- =====================================================================================

select 'applications eligible' as preview, count(*) as rows
from public.manager_application_records a
join _unique_resident_subject s on s.email = lower(btrim(a.resident_email))
where nullif(btrim(coalesce(a.row_data->>'residentUserId', '')), '') is null;

select 'applications still unbound after' as preview, count(*) as rows
from public.manager_application_records a
left join _unique_resident_subject s on s.email = lower(btrim(a.resident_email))
where nullif(btrim(coalesce(a.row_data->>'residentUserId', '')), '') is null
  and s.resident_user_id is null;

select 'work orders with a resident email and no subject' as preview, count(*) as rows
from public.portal_work_order_records w
where w.resident_user_id is null
  and nullif(btrim(coalesce(w.resident_email, w.row_data->>'residentEmail', '')), '') is not null;

select 'service requests with a resident email and no subject' as preview, count(*) as rows
from public.portal_service_request_records q
where q.resident_user_id is null
  and nullif(btrim(coalesce(q.resident_email, q.row_data->>'residentEmail', '')), '') is not null;

-- =====================================================================================
-- STEP A -- applications
-- =====================================================================================

update public.manager_application_records a
set row_data = pg_catalog.jsonb_set(a.row_data, '{residentUserId}', pg_catalog.to_jsonb(s.resident_user_id::text), true),
    updated_at = now()
from _unique_resident_subject s
where s.email = lower(btrim(a.resident_email))
  and pg_catalog.jsonb_typeof(a.row_data) = 'object'
  -- Still null: a row bound since the preview (or by an earlier run) is left exactly as it is.
  and nullif(btrim(coalesce(a.row_data->>'residentUserId', '')), '') is null;

-- =====================================================================================
-- STEP B -- services, under the disabled subject-assign guard
-- =====================================================================================

-- Every (manager, property, subject) residency this database now proves: applications bound by
-- step A above, plus leases that already carry the subject.
create temporary table _resident_residency on commit drop as
select distinct manager_user_id, property_id, resident_user_id from (
  select a.manager_user_id,
         pg_catalog.btrim(x.property_id) as property_id,
         nullif(pg_catalog.btrim(a.row_data->>'residentUserId'), '')::uuid as resident_user_id
  from public.manager_application_records a
  cross join lateral (values
    (a.assigned_property_id), (a.property_id),
    (a.row_data->>'assignedPropertyId'), (a.row_data->>'propertyId'),
    (a.row_data#>>'{application,propertyId}')
  ) as x(property_id)
  where a.manager_user_id is not null
    and pg_catalog.jsonb_typeof(a.row_data) = 'object'
    -- Shape-checked: a stored value that is not a UUID would abort the whole transaction on the cast.
    and nullif(pg_catalog.btrim(a.row_data->>'residentUserId'), '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and nullif(pg_catalog.btrim(coalesce(a.row_data->>'withdrawnAt', '')), '') is null
    and pg_catalog.lower(pg_catalog.btrim(coalesce(a.row_data->>'bucket', ''))) not in ('rejected', 'withdrawn')
  union all
  select l.manager_user_id, pg_catalog.btrim(l.property_id), l.resident_user_id
  from public.portal_lease_pipeline_records l
  where l.manager_user_id is not null and l.resident_user_id is not null
) as residency
where manager_user_id is not null
  and resident_user_id is not null
  and nullif(property_id, '') is not null;

create index on _resident_residency (manager_user_id, property_id, resident_user_id);

alter table public.portal_work_order_records disable trigger resident_service_subject;
alter table public.portal_service_request_records disable trigger resident_service_subject;

update public.portal_work_order_records w
set resident_user_id = s.resident_user_id,
    row_data = pg_catalog.jsonb_set(w.row_data, '{residentUserId}', pg_catalog.to_jsonb(s.resident_user_id::text), true),
    resident_subject_was_bound = true,
    updated_at = now()
from _unique_resident_subject s
where w.resident_user_id is null
  and s.email = lower(btrim(coalesce(nullif(btrim(w.resident_email), ''), w.row_data->>'residentEmail')))
  and pg_catalog.jsonb_typeof(w.row_data) = 'object'
  and exists (
    select 1 from _resident_residency rr
    where rr.resident_user_id = s.resident_user_id
      and rr.manager_user_id = w.manager_user_id
      and rr.property_id = pg_catalog.btrim(coalesce(nullif(w.assigned_property_id, ''), w.property_id, ''))
  );

update public.portal_service_request_records q
set resident_user_id = s.resident_user_id,
    row_data = pg_catalog.jsonb_set(q.row_data, '{residentUserId}', pg_catalog.to_jsonb(s.resident_user_id::text), true),
    resident_subject_was_bound = true,
    updated_at = now()
from _unique_resident_subject s
where q.resident_user_id is null
  and s.email = lower(btrim(coalesce(nullif(btrim(q.resident_email), ''), q.row_data->>'residentEmail')))
  and pg_catalog.jsonb_typeof(q.row_data) = 'object'
  and exists (
    select 1 from _resident_residency rr
    where rr.resident_user_id = s.resident_user_id
      and rr.manager_user_id = q.manager_user_id
      and rr.property_id = pg_catalog.btrim(coalesce(q.property_id, ''))
  );

alter table public.portal_work_order_records enable trigger resident_service_subject;
alter table public.portal_service_request_records enable trigger resident_service_subject;

-- =====================================================================================
-- VERIFICATION -- read these before committing a dry run
-- =====================================================================================

select 'applications bound' as verify, count(*) as rows
from public.manager_application_records
where nullif(btrim(coalesce(row_data->>'residentUserId', '')), '') is not null;

select 'applications unbound' as verify, count(*) as rows
from public.manager_application_records
where nullif(btrim(coalesce(row_data->>'residentUserId', '')), '') is null;

select 'work orders bound' as verify, count(*) as rows from public.portal_work_order_records where resident_user_id is not null;
select 'work orders unbound' as verify, count(*) as rows from public.portal_work_order_records where resident_user_id is null;
select 'service requests bound' as verify, count(*) as rows from public.portal_service_request_records where resident_user_id is not null;
select 'service requests unbound' as verify, count(*) as rows from public.portal_service_request_records where resident_user_id is null;

-- The column and the payload must agree on every bound row; this must return 0.
select 'subject/payload disagreement' as verify, count(*) as rows from (
  select 1 from public.portal_work_order_records
  where resident_user_id is not null
    and nullif(btrim(coalesce(row_data->>'residentUserId', '')), '') is distinct from resident_user_id::text
  union all
  select 1 from public.portal_service_request_records
  where resident_user_id is not null
    and nullif(btrim(coalesce(row_data->>'residentUserId', '')), '') is distinct from resident_user_id::text
) as mismatched;

-- Both guard triggers must be enabled again; this must return 2 rows, both 'O'.
select 'guard trigger' as verify, c.relname as table_name, t.tgenabled
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
where t.tgname = 'resident_service_subject'
  and c.relname in ('portal_work_order_records', 'portal_service_request_records');

commit;
