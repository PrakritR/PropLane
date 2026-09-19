-- Authenticated SMS tests retain ordinary dev business writes, but any durable
-- proposal or notification projection they create must remain test-scoped after
-- request-local AsyncLocalStorage has ended. These identifiers intentionally do
-- not reference agent_sessions: deleting a test session must not turn a draft
-- or a queued receipt into an ordinary live record.

alter table public.agent_pending_actions
  add column if not exists sms_test_actor_user_id uuid,
  add column if not exists sms_test_manager_user_id uuid,
  add column if not exists sms_test_session_id uuid;

alter table public.agent_pending_actions
  drop constraint if exists agent_pending_actions_sms_test_identity_check,
  add constraint agent_pending_actions_sms_test_identity_check check (
    (sms_test_actor_user_id is null and sms_test_manager_user_id is null and sms_test_session_id is null)
    or
    (sms_test_actor_user_id is not null and sms_test_manager_user_id is not null and sms_test_session_id is not null)
  );

-- Earlier authenticated test turns already persisted their test session on the
-- proposal. Backfill before the immutable trigger so those drafts cannot be
-- surfaced or claimed as ordinary portal actions after this migration lands.
update public.agent_pending_actions action
set sms_test_actor_user_id=session.test_actor_user_id,
    sms_test_manager_user_id=session.sms_test_manager_user_id,
    sms_test_session_id=session.id
from public.agent_sessions session
where action.session_id=session.id
  and action.sms_test_actor_user_id is null
  and action.sms_test_manager_user_id is null
  and action.sms_test_session_id is null
  and session.test_actor_user_id is not null
  and session.sms_test_manager_user_id is not null;

create index if not exists agent_pending_actions_sms_test_identity_idx
  on public.agent_pending_actions (sms_test_actor_user_id, sms_test_manager_user_id, sms_test_session_id)
  where sms_test_actor_user_id is not null;

create or replace function public.prevent_agent_pending_action_sms_test_provenance_change()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if old.sms_test_actor_user_id is distinct from new.sms_test_actor_user_id
    or old.sms_test_manager_user_id is distinct from new.sms_test_manager_user_id
    or old.sms_test_session_id is distinct from new.sms_test_session_id then
    raise exception 'agent pending action SMS test provenance is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_pending_actions_sms_test_provenance_immutable on public.agent_pending_actions;
create trigger agent_pending_actions_sms_test_provenance_immutable
  before update on public.agent_pending_actions
  for each row execute function public.prevent_agent_pending_action_sms_test_provenance_change();

alter table public.action_events
  add column if not exists sms_test_actor_user_id uuid,
  add column if not exists sms_test_manager_user_id uuid,
  add column if not exists sms_test_session_id uuid;

alter table public.action_event_deliveries
  add column if not exists sms_test_actor_user_id uuid,
  add column if not exists sms_test_manager_user_id uuid,
  add column if not exists sms_test_session_id uuid;

alter table public.action_event_deliveries
  drop constraint if exists work_order_event_deliveries_status_check,
  drop constraint if exists action_event_deliveries_status_check,
  add constraint action_event_deliveries_status_check
    check (status in (
      'pending', 'delivered', 'submitted', 'failed', 'email_failed',
      'sms_failed', 'channels_failed', 'deferred', 'digested', 'captured'
    ));

create index if not exists action_event_deliveries_sms_test_terminal_idx
  on public.action_event_deliveries (sms_test_session_id, status)
  where sms_test_session_id is not null;

-- A dispatch-created vendor session has no SMS-test mode of its own because it
-- is not a user-facing SMS-test session. Keep a separate immutable origin so
-- inbound live-phone lookup cannot enroll it after the test request completes.
alter table public.agent_sessions
  add column if not exists sms_test_origin_actor_user_id uuid,
  add column if not exists sms_test_origin_manager_user_id uuid,
  add column if not exists sms_test_origin_session_id uuid;

alter table public.agent_sessions
  drop constraint if exists agent_sessions_sms_test_origin_check,
  add constraint agent_sessions_sms_test_origin_check check (
    (sms_test_origin_actor_user_id is null and sms_test_origin_manager_user_id is null and sms_test_origin_session_id is null)
    or
    (sms_test_origin_actor_user_id is not null and sms_test_origin_manager_user_id is not null and sms_test_origin_session_id is not null)
  );

create or replace function public.prevent_agent_session_sms_test_origin_change()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if old.sms_test_origin_session_id is not null and (
    old.sms_test_origin_actor_user_id is distinct from new.sms_test_origin_actor_user_id
    or old.sms_test_origin_manager_user_id is distinct from new.sms_test_origin_manager_user_id
    or old.sms_test_origin_session_id is distinct from new.sms_test_origin_session_id
  ) then
    raise exception 'agent session SMS test origin is immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists agent_sessions_sms_test_origin_immutable on public.agent_sessions;
create trigger agent_sessions_sms_test_origin_immutable
  before update on public.agent_sessions
  for each row execute function public.prevent_agent_session_sms_test_origin_change();

create index if not exists agent_sessions_vendor_sms_test_origin_idx
  on public.agent_sessions (vendor_phone_e164, updated_at desc)
  where kind='vendor_work_order' and sms_test_origin_session_id is null;

-- These relational sources are consumed by delayed inspection and outgoing
-- payment reminders. Plain UUIDs intentionally preserve their test origin even
-- after the in-app test session is deleted.
alter table public.resident_inspections
  add column if not exists sms_test_session_id uuid,
  add column if not exists sms_test_actor_user_id uuid,
  add column if not exists sms_test_manager_user_id uuid;

alter table public.manager_bills
  add column if not exists sms_test_session_id uuid,
  add column if not exists sms_test_actor_user_id uuid,
  add column if not exists sms_test_manager_user_id uuid;

-- A test mutation can cancel, delete, or move an ordinary planned tour. Make
-- the provenance part of the singleton payload before the original mutation
-- core sees it, under its same advisory lock. This lets the existing mutation
-- retain all schedule/reservation semantics while the cleanup trigger observes
-- the test identity in the same transaction.
-- The guard makes this repeat-safe. PostgreSQL invalidates cached PL/pgSQL
-- statement plans on this pg_proc DDL, so callers resolve the replacement
-- public wrapper rather than retaining the renamed function OID.
do $$
begin
  if to_regprocedure('public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean)') is not null
    and to_regprocedure('public.mutate_confirmed_tour_schedule_core(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean)') is null then
    alter function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean)
      rename to mutate_confirmed_tour_schedule_core;
  end if;
end;
$$;

create or replace function public.mutate_confirmed_tour_schedule(
  p_operation text,
  p_event jsonb,
  p_remove_inquiry_ids text[] default '{}'::text[],
  p_allow_conflict boolean default false,
  p_expected_start timestamptz default null,
  p_expected_end timestamptz default null,
  p_expected_generation text default null,
  p_expected_generation_known boolean default false
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event jsonb := coalesce(p_event,'{}'::jsonb);
  v_existing jsonb;
  v_provenance jsonb;
  v_event_id text := nullif(trim(v_event->>'id'),'');
begin
  if p_operation not in ('append','append_event','cancel','delete','replace','patch') or v_event_id is null then
    raise exception 'invalid tour schedule mutation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule',0));
  select value into v_existing
    from public.portal_schedule_records r,
      jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value
    where r.id='axis_admin_planned_events_v1' and value->>'id'=v_event_id
    for update;

  -- The authenticated test marker is an object containing all three identity
  -- values. Prefer the incoming mutation; otherwise retain an existing marker
  -- through a replacement so a test update cannot re-open a later live cleanup.
  v_provenance := case
    when jsonb_typeof(v_event->'smsTestProvenance')='object'
      and coalesce(trim(v_event->'smsTestProvenance'->>'actorUserId'),'')<>''
      and coalesce(trim(v_event->'smsTestProvenance'->>'managerUserId'),'')<>''
      and coalesce(trim(v_event->'smsTestProvenance'->>'sessionId'),'')<>''
      then v_event->'smsTestProvenance'
    when jsonb_typeof(v_existing->'smsTestProvenance')='object'
      and coalesce(trim(v_existing->'smsTestProvenance'->>'actorUserId'),'')<>''
      and coalesce(trim(v_existing->'smsTestProvenance'->>'managerUserId'),'')<>''
      and coalesce(trim(v_existing->'smsTestProvenance'->>'sessionId'),'')<>''
      then v_existing->'smsTestProvenance'
    else null
  end;
  if v_provenance is not null then
    v_event := v_event || jsonb_build_object(
      'smsTestProvenance',v_provenance,'smsTestSessionId',v_provenance->>'sessionId'
    );
    -- For cancel/delete, the core carries the current payload forward or
    -- removes it. Stamp the old JSON row first so the cleanup trigger sees it.
    if v_existing is not null and v_existing->'smsTestProvenance' is distinct from v_provenance then
      update public.portal_schedule_records r set
        row_data=r.row_data || jsonb_build_object('payload',(
          select coalesce(jsonb_agg(case when value->>'id'=v_event_id then
            value || jsonb_build_object('smsTestProvenance',v_provenance,'smsTestSessionId',v_provenance->>'sessionId')
            else value end),'[]'::jsonb)
          from jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value
        )),updated_at=now()
      where r.id='axis_admin_planned_events_v1';
    end if;
  end if;
  return public.mutate_confirmed_tour_schedule_core(
    p_operation,v_event,p_remove_inquiry_ids,p_allow_conflict,
    p_expected_start,p_expected_end,p_expected_generation,p_expected_generation_known
  );
end;
$$;

alter table public.prospect_tour_google_calendar_cleanup
  add column if not exists sms_test_actor_user_id uuid,
  add column if not exists sms_test_manager_user_id uuid,
  add column if not exists sms_test_session_id uuid;

alter table public.prospect_tour_google_calendar_cleanup
  drop constraint if exists prospect_tour_google_calendar_cleanup_status_check,
  add constraint prospect_tour_google_calendar_cleanup_status_check
    check (status in ('pending','running','completed','captured'));

create or replace function public.capture_confirmed_tour_google_calendar_cleanup()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_old jsonb; v_replacement jsonb; v_manager uuid; v_provenance jsonb;
begin
  if new.id <> 'axis_admin_planned_events_v1' then return new; end if;
  for v_old in select value from jsonb_array_elements(coalesce(old.row_data->'payload','[]'::jsonb)) value loop
    if v_old->>'kind' <> 'tour' or coalesce(v_old->>'canceledAt','') <> '' then continue; end if;
    select value into v_replacement from jsonb_array_elements(coalesce(new.row_data->'payload','[]'::jsonb)) value
      where value->>'id'=v_old->>'id';
    if found and coalesce(v_replacement->>'canceledAt','')='' then continue; end if;
    begin v_manager := nullif(v_old->>'managerUserId','')::uuid;
    exception when invalid_text_representation then continue;
    end;
    v_provenance := coalesce(v_replacement->'smsTestProvenance',v_old->'smsTestProvenance');
    if jsonb_typeof(v_provenance)='object'
      and coalesce(trim(v_provenance->>'actorUserId'),'')<>''
      and coalesce(trim(v_provenance->>'managerUserId'),'')<>''
      and coalesce(trim(v_provenance->>'sessionId'),'')<>'' then
      insert into public.prospect_tour_google_calendar_cleanup(
        planned_event_id,manager_user_id,google_calendar_event_id,status,attempts,last_error,
        lease_owner,lease_expires_at,completed_at,sms_test_actor_user_id,sms_test_manager_user_id,sms_test_session_id,updated_at
      ) values (
        v_old->>'id',v_manager,coalesce(nullif(v_old->>'googleCalendarEventId',''),
          encode(pg_catalog.sha256(pg_catalog.convert_to(v_manager::text||':'||(v_old->>'id'),'UTF8')),'hex')),
        'captured',0,'authenticated_sms_test',null,null,now(),
        (v_provenance->>'actorUserId')::uuid,(v_provenance->>'managerUserId')::uuid,(v_provenance->>'sessionId')::uuid,now()
      ) on conflict(planned_event_id) do update set
        status='captured',last_error='authenticated_sms_test',lease_owner=null,lease_expires_at=null,
        completed_at=now(),sms_test_actor_user_id=excluded.sms_test_actor_user_id,
        sms_test_manager_user_id=excluded.sms_test_manager_user_id,sms_test_session_id=excluded.sms_test_session_id,updated_at=now();
    else
      perform public.enqueue_prospect_tour_google_calendar_cleanup(
        v_manager,v_old->>'id',nullif(v_old->>'googleCalendarEventId','')
      );
    end if;
  end loop;
  return new;
end;
$$;

create or replace function public.claim_prospect_tour_google_calendar_cleanup(
  p_worker_id text,p_lease_seconds integer default 120
) returns table(planned_event_id text,manager_user_id uuid,google_calendar_event_id text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row public.prospect_tour_google_calendar_cleanup;
begin
  select c.* into v_row from public.prospect_tour_google_calendar_cleanup c
    where c.sms_test_session_id is null
      and (c.status='pending' or (c.status='running' and c.lease_expires_at<=now()))
    order by c.updated_at asc for update skip locked limit 1;
  if not found then return; end if;
  update public.prospect_tour_google_calendar_cleanup c set status='running',attempts=c.attempts+1,
    lease_owner=p_worker_id,lease_expires_at=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,300))),updated_at=now()
    where c.planned_event_id=v_row.planned_event_id;
  return query select v_row.planned_event_id,v_row.manager_user_id,v_row.google_calendar_event_id;
end;
$$;

revoke execute on function public.mutate_confirmed_tour_schedule_core(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) from public,anon,authenticated;
revoke execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) from public,anon,authenticated;
grant execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) to service_role;
