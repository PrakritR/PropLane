-- Final durability repair for autonomous prospect-tour side effects. Existing
-- September migrations are immutable; all objects here are additive/replaced.

create table if not exists public.prospect_tour_google_calendar_cleanup (
  planned_event_id text primary key,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  google_calendar_event_id text not null,
  status text not null default 'pending' check (status in ('pending','running','completed')),
  attempts integer not null default 0,
  last_error text,
  lease_owner text,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prospect_tour_google_calendar_cleanup_pending_idx
  on public.prospect_tour_google_calendar_cleanup(status, updated_at)
  where status in ('pending','running');

-- The remote create uses this exact deterministic id. Keep a cleanup intent
-- even when its id was never persisted into the JSON event before a crash.
create or replace function public.enqueue_prospect_tour_google_calendar_cleanup(
  p_manager_user_id uuid,
  p_planned_event_id text,
  p_google_calendar_event_id text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event_id text := nullif(trim(p_planned_event_id),''); v_remote_id text;
begin
  if p_manager_user_id is null or v_event_id is null then return; end if;
  v_remote_id := coalesce(
    nullif(trim(p_google_calendar_event_id),''),
    encode(pg_catalog.sha256(pg_catalog.convert_to(p_manager_user_id::text || ':' || v_event_id, 'UTF8')), 'hex')
  );
  insert into public.prospect_tour_google_calendar_cleanup(
    planned_event_id,manager_user_id,google_calendar_event_id,status,attempts,last_error,lease_owner,lease_expires_at,completed_at,updated_at
  ) values (v_event_id,p_manager_user_id,v_remote_id,'pending',0,null,null,null,null,now())
  on conflict (planned_event_id) do update set
    manager_user_id=excluded.manager_user_id,
    google_calendar_event_id=excluded.google_calendar_event_id,
    status='pending',
    lease_owner=null,
    lease_expires_at=null,
    completed_at=null,
    updated_at=now();
end; $$;

-- Every cancellation/deletion goes through the schedule singleton. Capture its
-- cleanup obligation in the same transaction, including pre-persistence
-- remote creates whose event JSON has no Google id yet.
create or replace function public.capture_confirmed_tour_google_calendar_cleanup()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old jsonb; v_new jsonb; v_replacement jsonb; v_manager uuid;
begin
  if new.id <> 'axis_admin_planned_events_v1' then return new; end if;
  for v_old in select value from jsonb_array_elements(coalesce(old.row_data->'payload','[]'::jsonb)) value loop
    if v_old->>'kind' <> 'tour' or coalesce(v_old->>'canceledAt','') <> '' then continue; end if;
    select value into v_replacement from jsonb_array_elements(coalesce(new.row_data->'payload','[]'::jsonb)) value
      where value->>'id'=v_old->>'id';
    if found and coalesce(v_replacement->>'canceledAt','')='' then continue; end if;
    begin
      v_manager := nullif(v_old->>'managerUserId','')::uuid;
    exception when invalid_text_representation then
      continue;
    end;
    perform public.enqueue_prospect_tour_google_calendar_cleanup(
      v_manager, v_old->>'id', nullif(v_old->>'googleCalendarEventId','')
    );
  end loop;
  return new;
end; $$;
drop trigger if exists capture_confirmed_tour_google_calendar_cleanup on public.portal_schedule_records;
create trigger capture_confirmed_tour_google_calendar_cleanup
after update of row_data on public.portal_schedule_records
for each row execute function public.capture_confirmed_tour_google_calendar_cleanup();

create or replace function public.claim_prospect_tour_google_calendar_cleanup(
  p_worker_id text,
  p_lease_seconds integer default 120
) returns table(planned_event_id text, manager_user_id uuid, google_calendar_event_id text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.prospect_tour_google_calendar_cleanup;
begin
  select c.* into v_row from public.prospect_tour_google_calendar_cleanup c
    where c.status='pending' or (c.status='running' and c.lease_expires_at<=now())
    order by c.updated_at asc for update skip locked limit 1;
  if not found then return; end if;
  update public.prospect_tour_google_calendar_cleanup c set status='running',attempts=c.attempts+1,
    lease_owner=p_worker_id,lease_expires_at=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,300))),updated_at=now()
    where c.planned_event_id=v_row.planned_event_id;
  return query select v_row.planned_event_id,v_row.manager_user_id,v_row.google_calendar_event_id;
end; $$;

-- Atomically adopt a pre-correction burst row or create the only booking-keyed
-- confirmation. A submitted/submitting/unknown legacy row suppresses a new
-- send; a pre-dispatch row is terminally superseded while locked.
create or replace function public.prepare_prospect_tour_booking_confirmation(
  p_booking_id uuid,
  p_manager_user_id uuid, p_actor_user_id uuid, p_recipient_user_id uuid,
  p_recipient_email text, p_recipient_phone text, p_body text, p_send_class text,
  p_purpose text, p_conversation_key text, p_counterparty_role text, p_property_id text,
  p_recipient_timezone text, p_dedupe_key text, p_trace_id text, p_segment_count integer,
  p_status text, p_available_at timestamptz, p_blocked_reason text,
  p_burst_id uuid default null, p_burst_revision integer default null, p_burst_worker_id text default null,
  p_transport text default 'twilio', p_transport_from_number text default null,
  p_candidate_context jsonb default null, p_candidate_shadow_snapshot jsonb default null
) returns table(outbox_id uuid, status text, terminal boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_booking public.prospect_tour_bookings; v_outbox public.sms_outbox; v_legacy public.sms_outbox;
  v_events jsonb; v_event jsonb; v_burst public.prospect_sms_bursts; v_attach_burst boolean := false;
begin
  if p_booking_id is null or p_manager_user_id is null or p_status not in ('queued','deferred') then
    raise exception 'invalid prospect tour confirmation preparation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select * into v_booking from public.prospect_tour_bookings where id=p_booking_id for update;
  if not found or v_booking.manager_user_id<>p_manager_user_id then return query select null::uuid,'blocked'::text,true; return; end if;
  select coalesce(row_data->'payload','[]'::jsonb) into v_events from public.portal_schedule_records
    where id='axis_admin_planned_events_v1' for update;
  select value into v_event from jsonb_array_elements(coalesce(v_events,'[]'::jsonb)) value
    where value->>'id'=v_booking.planned_event_id;
  if v_booking.status<>'confirmed' or v_event is null or coalesce(v_event->>'canceledAt','')<>''
    or v_event->>'start' is distinct from v_booking.event_snapshot->>'start'
    or v_event->>'end' is distinct from v_booking.event_snapshot->>'end'
    or v_event->>'slotKey' is distinct from v_booking.event_snapshot->>'slotKey' then
    update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now()
      where id=p_booking_id and confirmation_status in ('pending','prepared');
    return query select null::uuid,'blocked'::text,true; return;
  end if;
  if p_burst_id is not null then
    if p_burst_id is distinct from v_booking.burst_id or p_burst_revision is distinct from v_booking.burst_revision
      or coalesce(trim(p_burst_worker_id),'')='' or p_transport not in ('twilio','claw') then
      raise exception 'invalid prospect tour confirmation burst';
    end if;
    select * into v_burst from public.prospect_sms_bursts where id=p_burst_id for update;
    v_attach_burst := found and v_burst.revision=p_burst_revision and v_burst.status='generating'
      and v_burst.lease_owner=p_burst_worker_id and v_burst.lease_expires_at>now();
    -- The normal worker has to preserve the burst completion/history fence.
    -- A stale lease may only be recovered by the booking sweep, which calls
    -- this operation without worker-bound burst arguments.
    if not v_attach_burst then return; end if;
  end if;
  select * into v_outbox from public.sms_outbox where prospect_tour_booking_confirmation_id=p_booking_id for update;
  if found then
    update public.prospect_tour_bookings set confirmation_outbox_id=v_outbox.id,
      confirmation_status=case when v_outbox.status in ('submitted','sent','delivered') then 'submitted'
        when v_outbox.status in ('blocked','unknown') then 'blocked' else 'prepared' end,updated_at=now()
      where id=p_booking_id;
    return query select v_outbox.id,v_outbox.status,(v_outbox.status in ('submitted','sent','delivered','blocked','unknown'));
    return;
  end if;
  select * into v_legacy from public.sms_outbox where prospect_burst_id=v_booking.burst_id
    and prospect_burst_revision=v_booking.burst_revision for update;
  if found and v_legacy.status in ('submitting','submitted','sent','delivered','unknown') then
    update public.sms_outbox set prospect_tour_booking_confirmation_id=p_booking_id,updated_at=now()
      where id=v_legacy.id and prospect_tour_booking_confirmation_id is null;
    update public.prospect_tour_bookings set confirmation_outbox_id=v_legacy.id,
      confirmation_status=case when v_legacy.status in ('submitted','sent','delivered') then 'submitted' else 'blocked' end,updated_at=now()
      where id=p_booking_id;
    return query select v_legacy.id,v_legacy.status,true; return;
  end if;
  if found and v_legacy.status in ('queued','deferred','claimed') then
    -- Keep a safely pre-dispatch legacy row and convert it in place. The
    -- booking submit fence will finalize its burst history/budget atomically.
    update public.sms_outbox set prospect_tour_booking_confirmation_id=p_booking_id,updated_at=now()
      where id=v_legacy.id and prospect_tour_booking_confirmation_id is null;
    update public.prospect_tour_bookings set confirmation_outbox_id=v_legacy.id,confirmation_status='prepared',updated_at=now()
      where id=p_booking_id;
    return query select v_legacy.id,v_legacy.status,false; return;
  end if;
  if found then
    update public.sms_outbox set status='blocked',blocked_reason='prospect_tour_confirmation_superseded',
      lease_owner=null,lease_expires_at=null,updated_at=now() where id=v_legacy.id;
  end if;
  insert into public.sms_outbox(
    manager_user_id,actor_user_id,recipient_user_id,recipient_email,recipient_phone,body,send_class,purpose,
    conversation_key,counterparty_role,property_id,recipient_timezone,dedupe_key,trace_id,
    prospect_tour_booking_confirmation_id,prospect_burst_id,prospect_burst_revision,prospect_burst_worker_id,
    transport,transport_from_number,segment_count,status,available_at,blocked_reason
  ) values (
    p_manager_user_id,p_actor_user_id,p_recipient_user_id,p_recipient_email,p_recipient_phone,p_body,p_send_class,p_purpose,
    p_conversation_key,p_counterparty_role,p_property_id,p_recipient_timezone,p_dedupe_key,p_trace_id,
    p_booking_id,case when v_attach_burst then p_burst_id else null end,case when v_attach_burst then p_burst_revision else null end,
    case when v_attach_burst then p_burst_worker_id else null end,case when v_attach_burst then p_transport else 'twilio' end,
    case when v_attach_burst then p_transport_from_number else null end,p_segment_count,p_status,p_available_at,p_blocked_reason
  ) returning * into v_outbox;
  if v_attach_burst then
    update public.prospect_sms_bursts set status='prepared',outbox_id=v_outbox.id,candidate_body=v_outbox.body,
      candidate_context=p_candidate_context,candidate_shadow_snapshot=p_candidate_shadow_snapshot,
      lease_owner=null,lease_expires_at=null,updated_at=now()
      where id=v_burst.id and revision=p_burst_revision and status='generating'
        and lease_owner=p_burst_worker_id and lease_expires_at>now();
    if not found then raise exception 'prospect tour confirmation burst lease lost'; end if;
  end if;
  update public.prospect_tour_bookings set confirmation_outbox_id=v_outbox.id,confirmation_status='prepared',updated_at=now()
    where id=p_booking_id;
  return query select v_outbox.id,v_outbox.status,false;
end; $$;

-- Booking confirmations which adopted a burst row must keep the old burst's
-- completion semantics. The lock order is booking -> burst -> outbox, matching
-- the generic path's booking probe before it takes burst/outbox locks.
create or replace function public.begin_prospect_tour_booking_confirmation_submission(
  p_booking_id uuid, p_outbox_id uuid, p_outbox_worker_id text, p_attempt_id uuid,
  p_dispatch_started_at timestamptz
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_booking public.prospect_tour_bookings; v_outbox public.sms_outbox; v_burst public.prospect_sms_bursts;
  v_events jsonb; v_event jsonb; v_budget_available boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select * into v_booking from public.prospect_tour_bookings where id=p_booking_id for update;
  if not found then return 'unavailable'; end if;
  if v_booking.burst_id is not null then
    select * into v_burst from public.prospect_sms_bursts where id=v_booking.burst_id for update;
    if not found then return 'unavailable'; end if;
  end if;
  select * into v_outbox from public.sms_outbox where id=p_outbox_id for update;
  if not found or v_outbox.status is distinct from 'claimed' or v_outbox.lease_owner is distinct from p_outbox_worker_id
    or v_outbox.lease_expires_at is null or v_outbox.lease_expires_at<=p_dispatch_started_at
    or v_outbox.prospect_tour_booking_confirmation_id is distinct from p_booking_id then return 'unavailable'; end if;
  perform 1 from public.sms_delivery_attempts where id=p_attempt_id and outbox_id=p_outbox_id and state='submitting';
  if not found then return 'unavailable'; end if;
  select coalesce(row_data->'payload','[]'::jsonb) into v_events from public.portal_schedule_records
    where id='axis_admin_planned_events_v1' for update;
  select value into v_event from jsonb_array_elements(coalesce(v_events,'[]'::jsonb)) value where value->>'id'=v_booking.planned_event_id;
  if v_booking.status is distinct from 'confirmed' or v_event is null or coalesce(v_event->>'canceledAt','')<>''
    or v_event->>'start' is distinct from v_booking.event_snapshot->>'start'
    or v_event->>'end' is distinct from v_booking.event_snapshot->>'end'
    or v_event->>'slotKey' is distinct from v_booking.event_snapshot->>'slotKey' then
    update public.sms_outbox set status='blocked',blocked_reason='prospect_tour_confirmation_stale',lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
    update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now() where id=p_booking_id and confirmation_outbox_id=p_outbox_id;
    update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now() where id=p_attempt_id and outbox_id=p_outbox_id;
    return 'stale';
  end if;
  if v_outbox.prospect_burst_id is not null then
    if v_outbox.prospect_burst_id is distinct from v_booking.burst_id
      or v_outbox.prospect_burst_revision is distinct from v_booking.burst_revision
      or v_burst.revision is distinct from v_booking.burst_revision
      or v_burst.status is distinct from 'prepared' or v_burst.outbox_id is distinct from v_outbox.id then
      update public.sms_outbox set status='blocked',blocked_reason='prospect_tour_confirmation_stale',lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
      update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now() where id=p_booking_id;
      update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now() where id=p_attempt_id and outbox_id=p_outbox_id;
      return 'stale';
    end if;
    select public.spend_sms_segment_budget(v_outbox.segment_count) into v_budget_available;
    if v_budget_available is distinct from true then return 'budget_exhausted'; end if;
    update public.prospect_sms_bursts set status='dispatched',handled_revision=revision,outbox_id=v_outbox.id,
      candidate_body=v_outbox.body,lease_owner=null,lease_expires_at=null,history_snapshot=candidate_context,
      candidate_context=null,candidate_shadow_snapshot=null,updated_at=now() where id=v_burst.id;
    if v_burst.candidate_shadow_snapshot is not null then
      insert into public.prospect_sms_shadow_jobs(burst_id,burst_revision,manager_user_id,snapshot)
      values(v_burst.id,v_burst.revision,v_burst.manager_user_id,v_burst.candidate_shadow_snapshot)
      on conflict(burst_id,burst_revision) do nothing;
    end if;
  end if;
  update public.sms_outbox set status='submitting',dispatch_started_at=p_dispatch_started_at,updated_at=p_dispatch_started_at where id=p_outbox_id;
  return 'started';
end; $$;

-- A legacy generic dispatcher must never cross its old burst-only fence once a
-- booking exists. It tags the row while all relevant locks are held, then lets
-- booking recovery own the lifecycle/budget/history transition.
create or replace function public.begin_sms_outbox_submission(
  p_outbox_id uuid, p_outbox_worker_id text, p_attempt_id uuid, p_dispatch_started_at timestamptz, p_segments integer
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_outbox public.sms_outbox; v_burst public.prospect_sms_bursts; v_booking_id uuid; v_budget_available boolean; v_burst_id uuid;
begin
  select prospect_burst_id into v_burst_id from public.sms_outbox where id=p_outbox_id;
  if not found then return 'unavailable'; end if;
  if v_burst_id is not null then
    select id into v_booking_id from public.prospect_tour_bookings where burst_id=v_burst_id
      and burst_revision=(select prospect_burst_revision from public.sms_outbox where id=p_outbox_id)
      for update;
  end if;
  if v_burst_id is not null then select * into v_burst from public.prospect_sms_bursts where id=v_burst_id for update; if not found then return 'unavailable'; end if; end if;
  select * into v_outbox from public.sms_outbox where id=p_outbox_id for update;
  if not found or v_outbox.status<>'claimed' or v_outbox.lease_owner<>p_outbox_worker_id or v_outbox.lease_expires_at<=p_dispatch_started_at then return 'unavailable'; end if;
  if v_booking_id is not null then
    update public.sms_outbox set prospect_tour_booking_confirmation_id=v_booking_id,updated_at=now()
      where id=p_outbox_id and prospect_tour_booking_confirmation_id is null;
    update public.prospect_tour_bookings set confirmation_outbox_id=p_outbox_id,confirmation_status='prepared',updated_at=now() where id=v_booking_id;
    return 'booking_required';
  end if;
  if v_outbox.prospect_burst_id is not null then
    if v_outbox.prospect_burst_id<>v_burst_id or v_burst.revision<>v_outbox.prospect_burst_revision or v_burst.status<>'prepared' or v_burst.outbox_id<>v_outbox.id then
      update public.sms_outbox set status='blocked',blocked_reason='prospect_burst_stale',lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
      update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now() where id=p_attempt_id and outbox_id=p_outbox_id;
      return 'stale';
    end if;
    select public.spend_sms_segment_budget(p_segments) into v_budget_available;
    if v_budget_available is distinct from true then return 'budget_exhausted'; end if;
    update public.prospect_sms_bursts set status='dispatched',handled_revision=revision,outbox_id=v_outbox.id,candidate_body=v_outbox.body,
      lease_owner=null,lease_expires_at=null,history_snapshot=candidate_context,candidate_context=null,candidate_shadow_snapshot=null,updated_at=now() where id=v_burst.id;
    if v_burst.candidate_shadow_snapshot is not null then insert into public.prospect_sms_shadow_jobs(burst_id,burst_revision,manager_user_id,snapshot)
      values(v_burst.id,v_burst.revision,v_burst.manager_user_id,v_burst.candidate_shadow_snapshot) on conflict(burst_id,burst_revision) do nothing; end if;
  end if;
  update public.sms_outbox set status='submitting',dispatch_started_at=p_dispatch_started_at,updated_at=p_dispatch_started_at where id=p_outbox_id;
  return 'started';
end; $$;

alter table public.prospect_tour_google_calendar_cleanup enable row level security;
revoke all on table public.prospect_tour_google_calendar_cleanup from anon, authenticated;
grant select, insert, update, delete on table public.prospect_tour_google_calendar_cleanup to service_role;
revoke execute on function public.enqueue_prospect_tour_google_calendar_cleanup(uuid,text,text) from public, anon, authenticated;
revoke execute on function public.claim_prospect_tour_google_calendar_cleanup(text,integer) from public, anon, authenticated;
revoke execute on function public.prepare_prospect_tour_booking_confirmation(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,integer,text,timestamptz,text,uuid,integer,text,text,text,jsonb,jsonb) from public, anon, authenticated;
revoke execute on function public.begin_prospect_tour_booking_confirmation_submission(uuid,uuid,text,uuid,timestamptz) from public, anon, authenticated;
revoke execute on function public.begin_sms_outbox_submission(uuid,text,uuid,timestamptz,integer) from public, anon, authenticated;
grant execute on function public.enqueue_prospect_tour_google_calendar_cleanup(uuid,text,text) to service_role;
grant execute on function public.claim_prospect_tour_google_calendar_cleanup(text,integer) to service_role;
grant execute on function public.prepare_prospect_tour_booking_confirmation(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,integer,text,timestamptz,text,uuid,integer,text,text,text,jsonb,jsonb) to service_role;
grant execute on function public.begin_prospect_tour_booking_confirmation_submission(uuid,uuid,text,uuid,timestamptz) to service_role;
grant execute on function public.begin_sms_outbox_submission(uuid,text,uuid,timestamptz,integer) to service_role;
