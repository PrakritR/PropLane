-- Rollback-only staging/DEV probe for 20260913173000_tour_followup_recovery_guards.sql.
-- Run with psql and ON_ERROR_STOP, after the candidate migration is applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/testing/tour-followup-recovery-guards-probe.sql
--
-- This uses one hard-coded synthetic identity and one control key. It never calls
-- auth deletion, account purge, a provider, or a broad cleanup operation.
\set ON_ERROR_STOP on

begin;
set local lock_timeout = '5s';
set local statement_timeout = '15s';

do $probe_prerequisites$
declare
  trigger_count integer;
begin
  if to_regclass('public.manager_tour_followup_controls') is null
    or to_regprocedure('public.account_recovery_write_guard()') is null
    or to_regprocedure('public.account_recovery_capture_delete()') is null then
    raise exception 'tour follow-up recovery probe prerequisites are missing';
  end if;

  select count(*) into trigger_count
  from pg_trigger t
  where t.tgrelid = 'public.manager_tour_followup_controls'::regclass
    and not t.tgisinternal;
  if trigger_count <> 2 then
    raise exception 'expected exactly two non-internal recovery triggers, found %', trigger_count;
  end if;
  if exists(
    select 1
    from pg_trigger t
    where t.tgrelid = 'public.manager_tour_followup_controls'::regclass
      and not t.tgisinternal
      and (
        (t.tgname = 'account_recovery_write_guard'
          and (t.tgfoid <> 'public.account_recovery_write_guard()'::regprocedure
            or t.tgtype <> 31 or t.tgenabled <> 'O' or t.tgnargs <> 0
            or t.tgattr::text <> '' or t.tgqual is not null or t.tgconstraint <> 0))
        or (t.tgname = 'account_recovery_capture_delete'
          and (t.tgfoid <> 'public.account_recovery_capture_delete()'::regprocedure
            or t.tgtype <> 9 or t.tgenabled <> 'O' or t.tgnargs <> 0
            or t.tgattr::text <> '' or t.tgqual is not null or t.tgconstraint <> 0))
        or t.tgname not in ('account_recovery_write_guard','account_recovery_capture_delete')
      )
  ) then
    raise exception 'manager_tour_followup_controls recovery trigger catalog is not exact';
  end if;
end
$probe_prerequisites$;

select t.tgname,
  n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as function_name,
  t.tgtype, t.tgattr::text as tgattr, t.tgenabled, t.tgnargs, t.tgqual is not null as has_when, t.tgconstraint,
  t.tgisinternal
from pg_trigger t
join pg_class c on c.oid=t.tgrelid
join pg_proc p on p.oid=t.tgfoid
join pg_namespace n on n.oid=p.pronamespace
where c.oid='public.manager_tour_followup_controls'::regclass
  and not t.tgisinternal
order by t.tgname;

-- Fail closed if this synthetic fixture already exists. The transaction below
-- must never attach itself to a prior run or a real account.
do $probe_fixture_guard$
begin
  if exists(select 1 from auth.users where id='00000000-0000-0000-0000-00000000a472'::uuid)
    or exists(select 1 from auth.users where lower(email)='qa-recovery-guards-a472@example.test')
    or exists(select 1 from public.profiles where id='00000000-0000-0000-0000-00000000a472'::uuid)
    or exists(select 1 from public.profiles where lower(email)='qa-recovery-guards-a472@example.test')
    or exists(select 1 from public.profile_roles where user_id='00000000-0000-0000-0000-00000000a472'::uuid)
    or exists(select 1 from public.manager_tour_followup_controls
      where manager_user_id='00000000-0000-0000-0000-00000000a472'::uuid
        and conversation_key='qa-recovery-guards:0001')
    or exists(select 1 from public.account_recovery_requests
      where user_id='00000000-0000-0000-0000-00000000a472'::uuid
        or lower(email)='qa-recovery-guards-a472@example.test')
    or exists(select 1 from public.account_recovery_records r
      where r.table_name='manager_tour_followup_controls'
        and coalesce(r.row_key,r.payload)->>'manager_user_id'='00000000-0000-0000-0000-00000000a472'
        and coalesce(r.row_key,r.payload)->>'conversation_key'='qa-recovery-guards:0001')
    or exists(select 1 from public.account_recovery_holds h
      join public.account_recovery_records r on r.id=h.record_id
      where r.table_name='manager_tour_followup_controls'
        and coalesce(r.row_key,r.payload)->>'manager_user_id'='00000000-0000-0000-0000-00000000a472'
        and coalesce(r.row_key,r.payload)->>'conversation_key'='qa-recovery-guards:0001') then
    raise exception 'synthetic recovery probe fixture already exists; refusing to reuse it';
  end if;
end
$probe_fixture_guard$;

insert into auth.users(id,email,raw_user_meta_data)
values(
  '00000000-0000-0000-0000-00000000a472'::uuid,
  'qa-recovery-guards-a472@example.test',
  '{"role":"manager"}'::jsonb
);
insert into public.profiles(id,role,email)
values('00000000-0000-0000-0000-00000000a472'::uuid,'manager','qa-recovery-guards-a472@example.test')
on conflict(id) do update set role=excluded.role,email=excluded.email;
insert into public.profile_roles(user_id,role)
values('00000000-0000-0000-0000-00000000a472'::uuid,'manager')
on conflict(user_id,role) do nothing;
insert into public.manager_tour_followup_controls(manager_user_id,conversation_key,archived)
values('00000000-0000-0000-0000-00000000a472'::uuid,'qa-recovery-guards:0001',false);

create temporary table qa_tour_followup_recovery_probe_request(request_id uuid) on commit drop;
insert into qa_tour_followup_recovery_probe_request(request_id)
select public.account_recovery_begin(
  '00000000-0000-0000-0000-00000000a472'::uuid,
  'manager',
  '{"rules":[{"table":"manager_tour_followup_controls","ids":["manager_user_id"],"recover":true,"phase":2}],"recoverableTables":["manager_tour_followup_controls"]}'::jsonb,
  '{}'::jsonb
);
-- account_recovery_begin uses this marker while it snapshots. The application
-- purge transaction has a fresh boundary, so clear it before exercising the
-- ordinary guard and capture branches below.
select set_config('proplane.account_recovery_internal','off',true);

select a.id as request_id, a.state, a.snapshot_complete, r.table_name, r.archived,
  h.kind, r.row_key
from qa_tour_followup_recovery_probe_request q
join public.account_recovery_requests a on a.id=q.request_id
join public.account_recovery_holds h on h.request_id=a.id
join public.account_recovery_records r on r.id=h.record_id
where r.table_name='manager_tour_followup_controls';

-- An ordinary write during the snapshot hold must be rejected. Catch the
-- expected trigger error so the surrounding transaction remains usable.
do $probe_blocked_update$
declare message text;
begin
  begin
    update public.manager_tour_followup_controls
    set archived=true
    where manager_user_id='00000000-0000-0000-0000-00000000a472'::uuid
      and conversation_key='qa-recovery-guards:0001';
    raise exception 'probe expected the held control update to be blocked';
  exception when others then
    message := sqlerrm;
    if position('Account recovery decision required' in message) = 0 then
      raise;
    end if;
    raise notice 'expected held-write rejection: %', message;
  end;
end
$probe_blocked_update$;

-- The captured delete is the normal manifest purge path. With the internal
-- marker off, the BEFORE guard permits only this exact held row while the
-- existing AFTER DELETE function archives its snapshot.
delete from public.manager_tour_followup_controls
where manager_user_id='00000000-0000-0000-0000-00000000a472'::uuid
  and conversation_key='qa-recovery-guards:0001';

select r.table_name, r.archived, a.state
from qa_tour_followup_recovery_probe_request q
join public.account_recovery_requests a on a.id=q.request_id
join public.account_recovery_holds h on h.request_id=a.id
join public.account_recovery_records r on r.id=h.record_id
where r.table_name='manager_tour_followup_controls';

do $probe_capture_assertion$
declare
  captured_count integer;
  captured_exact boolean;
begin
  select count(*), bool_and(
    h.kind='delete'
    and r.archived
    and r.recoverable
    and r.phase=2
    and a.state='archiving'
    and a.snapshot_complete
  ) into captured_count,captured_exact
  from qa_tour_followup_recovery_probe_request q
  join public.account_recovery_requests a on a.id=q.request_id
  join public.account_recovery_holds h on h.request_id=a.id
  join public.account_recovery_records r on r.id=h.record_id
  where r.table_name='manager_tour_followup_controls'
    and r.row_key->>'manager_user_id'='00000000-0000-0000-0000-00000000a472'
    and r.row_key->>'conversation_key'='qa-recovery-guards:0001';
  if captured_count <> 1 or captured_exact is distinct from true
    or exists(select 1 from public.manager_tour_followup_controls
      where manager_user_id='00000000-0000-0000-0000-00000000a472'::uuid
        and conversation_key='qa-recovery-guards:0001') then
    raise exception 'expected exactly one archived delete hold before finalization';
  end if;
end
$probe_capture_assertion$;

select public.account_recovery_finish_archival(request_id)
from qa_tour_followup_recovery_probe_request;

do $probe_finish_assertion$
declare request_state text;
begin
  select a.state into request_state
  from qa_tour_followup_recovery_probe_request q
  join public.account_recovery_requests a on a.id=q.request_id;
  if request_state is distinct from 'retained' then
    raise exception 'finish archival did not reach retained state: %', request_state;
  end if;
end
$probe_finish_assertion$;

select a.id as request_id, a.state, r.table_name, r.archived
from qa_tour_followup_recovery_probe_request q
join public.account_recovery_requests a on a.id=q.request_id
join public.account_recovery_holds h on h.request_id=a.id
join public.account_recovery_records r on r.id=h.record_id
where r.table_name='manager_tour_followup_controls';

rollback;

-- A second read transaction proves the fixture, hold, record and request did
-- not leak after the probe rollback. No cleanup mutation is issued here.
begin;
select
  (select count(*) from auth.users where id='00000000-0000-0000-0000-00000000a472'::uuid) as auth_fixture_rows,
  (select count(*) from public.profiles where id='00000000-0000-0000-0000-00000000a472'::uuid) as profile_fixture_rows,
  (select count(*) from public.profile_roles where user_id='00000000-0000-0000-0000-00000000a472'::uuid) as role_fixture_rows,
  (select count(*) from public.manager_tour_followup_controls
    where manager_user_id='00000000-0000-0000-0000-00000000a472'::uuid
      and conversation_key='qa-recovery-guards:0001') as control_fixture_rows,
  (select count(*) from public.account_recovery_requests where user_id='00000000-0000-0000-0000-00000000a472'::uuid) as recovery_request_rows,
  (select count(*) from public.account_recovery_records
    where table_name='manager_tour_followup_controls'
      and row_key->>'manager_user_id'='00000000-0000-0000-0000-00000000a472'
      and row_key->>'conversation_key'='qa-recovery-guards:0001') as recovery_record_rows,
  (select count(*) from public.account_recovery_holds h
    join public.account_recovery_records r on r.id=h.record_id
    where r.table_name='manager_tour_followup_controls'
      and r.row_key->>'manager_user_id'='00000000-0000-0000-0000-00000000a472'
      and r.row_key->>'conversation_key'='qa-recovery-guards:0001') as recovery_hold_rows;
do $probe_leak_assertion$
begin
  if exists(select 1 from auth.users where id='00000000-0000-0000-0000-00000000a472'::uuid)
    or exists(select 1 from public.profiles where id='00000000-0000-0000-0000-00000000a472'::uuid)
    or exists(select 1 from public.profile_roles where user_id='00000000-0000-0000-0000-00000000a472'::uuid)
    or exists(select 1 from public.manager_tour_followup_controls
      where manager_user_id='00000000-0000-0000-0000-00000000a472'::uuid
        and conversation_key='qa-recovery-guards:0001')
    or exists(select 1 from public.account_recovery_requests where user_id='00000000-0000-0000-0000-00000000a472'::uuid)
    or exists(select 1 from public.account_recovery_records
      where table_name='manager_tour_followup_controls'
        and row_key->>'manager_user_id'='00000000-0000-0000-0000-00000000a472'
        and row_key->>'conversation_key'='qa-recovery-guards:0001')
    or exists(select 1 from public.account_recovery_holds h
      join public.account_recovery_records r on r.id=h.record_id
      where r.table_name='manager_tour_followup_controls'
        and r.row_key->>'manager_user_id'='00000000-0000-0000-0000-00000000a472'
        and r.row_key->>'conversation_key'='qa-recovery-guards:0001') then
    raise exception 'rollback-only recovery probe fixture leaked';
  end if;
end
$probe_leak_assertion$;
rollback;
