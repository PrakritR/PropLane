-- One durable follow-up for a prospect tour-scheduling attempt. The intent is
-- registered before the assistant reply is submitted, but cannot become due
-- until that exact burst revision has crossed the SMS submission boundary.

create table if not exists public.prospect_sms_tour_reminders (
  id uuid primary key default gen_random_uuid(),
  burst_id uuid not null references public.prospect_sms_bursts(id) on delete cascade,
  burst_revision integer not null,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  scheduling_state_id uuid not null references public.prospect_tour_scheduling_state(id) on delete cascade,
  scheduling_state_revision integer not null,
  conversation_key text not null,
  recipient_phone_e164 text not null,
  property_id text,
  trace_id text,
  status text not null default 'waiting_submission'
    check (status in ('waiting_submission','scheduled','processing','enqueued','cancelled','blocked')),
  due_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  outbox_id uuid references public.sms_outbox(id) on delete set null,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (burst_id, burst_revision),
  unique (scheduling_state_id, scheduling_state_revision)
);

alter table public.sms_outbox
  add column if not exists prospect_tour_reminder_id uuid
    references public.prospect_sms_tour_reminders(id) on delete set null;
create unique index if not exists sms_outbox_prospect_tour_reminder_uniq
  on public.sms_outbox(prospect_tour_reminder_id)
  where prospect_tour_reminder_id is not null;

create index if not exists prospect_sms_tour_reminders_due_idx
  on public.prospect_sms_tour_reminders(due_at)
  where status in ('scheduled','processing');

create or replace function public.cancel_superseded_prospect_tour_reminder()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.revision <> old.revision then
    update public.sms_outbox o
      set status='blocked', blocked_reason='prospect_tour_reminder_stale',
          lease_owner=null, lease_expires_at=null, updated_at=now()
      from public.prospect_sms_tour_reminders r
      where r.burst_id=new.id and r.burst_revision < new.revision
        and o.prospect_tour_reminder_id=r.id
        and o.status in ('queued','deferred','claimed');
    update public.prospect_sms_tour_reminders
      set status='cancelled', blocked_reason='new_inbound', lease_owner=null,
          lease_expires_at=null, updated_at=now()
      where burst_id=new.id and burst_revision < new.revision
        and status in ('waiting_submission','scheduled','processing','enqueued');
  end if;
  return new;
end; $$;

drop trigger if exists cancel_superseded_prospect_tour_reminder on public.prospect_sms_bursts;
create trigger cancel_superseded_prospect_tour_reminder
after update of revision on public.prospect_sms_bursts
for each row execute function public.cancel_superseded_prospect_tour_reminder();

create or replace function public.register_prospect_sms_tour_reminder(
  p_burst_id uuid,
  p_burst_revision integer,
  p_manager_user_id uuid,
  p_conversation_key text,
  p_recipient_phone_e164 text,
  p_property_id text default null,
  p_trace_id text default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_state public.prospect_tour_scheduling_state; v_archived boolean := false;
begin
  if p_burst_id is null or p_burst_revision is null or p_manager_user_id is null
    or coalesce(trim(p_conversation_key),'')='' or coalesce(trim(p_recipient_phone_e164),'')=''
    or coalesce(trim(p_property_id),'')='' then
    return false;
  end if;
  perform 1 from public.prospect_sms_bursts
    where id=p_burst_id and revision=p_burst_revision
      and manager_user_id=p_manager_user_id
      and counterparty_phone_e164=p_recipient_phone_e164
      and status in ('generating','prepared','dispatched')
    for update;
  if not found then return false; end if;
  if to_regclass('public.manager_tour_followup_controls') is not null then
    execute 'select coalesce((select archived from public.manager_tour_followup_controls where manager_user_id=$1 and conversation_key=$2),false)'
      into v_archived using p_manager_user_id,trim(p_conversation_key);
    if v_archived then return false; end if;
  end if;
  select * into v_state from public.prospect_tour_scheduling_state
    where manager_user_id=p_manager_user_id and conversation_key=trim(p_conversation_key)
      and property_id=trim(p_property_id) and trusted_phone_e164=trim(p_recipient_phone_e164)
      and status in ('collecting','offered') for update;
  if not found then return false; end if;
  insert into public.prospect_sms_tour_reminders(
    burst_id,burst_revision,manager_user_id,scheduling_state_id,scheduling_state_revision,conversation_key,
    recipient_phone_e164,property_id,trace_id
  ) values (
    p_burst_id,p_burst_revision,p_manager_user_id,v_state.id,v_state.revision,trim(p_conversation_key),
    trim(p_recipient_phone_e164),nullif(trim(p_property_id),''),nullif(trim(p_trace_id),'')
  ) on conflict do nothing returning id into v_id;
  if v_id is not null then return true; end if;
  return exists (
    select 1 from public.prospect_sms_tour_reminders
      where scheduling_state_id=v_state.id and scheduling_state_revision=v_state.revision
        and status in ('waiting_submission','scheduled','processing','enqueued')
  );
end; $$;

create or replace function public.claim_prospect_sms_tour_reminders(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
) returns setof public.prospect_sms_tour_reminders
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(trim(p_worker_id),'')='' then return; end if;

  -- Only a reply that actually crossed the durable submission boundary starts
  -- the two-hour clock. A blocked/failed candidate can never create a follow-up.
  update public.prospect_sms_tour_reminders r
    set status='scheduled',
        due_at=coalesce(o.dispatch_started_at,o.updated_at)+interval '2 hours',
        updated_at=now()
    from public.prospect_sms_bursts b
    join public.sms_outbox o on o.id=b.outbox_id
    where r.burst_id=b.id and r.burst_revision=b.revision
      and r.status='waiting_submission'
      and b.status='dispatched' and b.handled_revision=r.burst_revision
      and o.status in ('submitted','sent','delivered');

  update public.prospect_sms_tour_reminders r
    set status='blocked', blocked_reason='originating_reply_not_confirmed',
        lease_owner=null, lease_expires_at=null, updated_at=now()
    from public.prospect_sms_bursts b
    left join public.sms_outbox o on o.id=b.outbox_id
    where r.burst_id=b.id and r.burst_revision=b.revision
      and r.status='waiting_submission'
      and (b.status='suppressed' or o.status in ('blocked','unknown'));

  -- A newer revision, a completed booking, handoff, deferral or opt-out makes
  -- the old scheduling attempt terminal even if its queue callback was late.
  update public.prospect_sms_tour_reminders r
    set status='cancelled', blocked_reason='attempt_no_longer_current',
        lease_owner=null, lease_expires_at=null, updated_at=now()
    where r.status in ('waiting_submission','scheduled','processing') and (
      not exists (
        select 1 from public.prospect_sms_bursts b
        where b.id=r.burst_id and b.revision=r.burst_revision
      ) or exists (
        select 1 from public.prospect_tour_scheduling_state s
        where s.id=r.scheduling_state_id
          and s.status in ('booked','cancelled','handoff','opted_out','deferred')
      )
    );

  return query
  with candidates as (
    select r.id from public.prospect_sms_tour_reminders r
      where (r.status='scheduled' or (r.status='processing' and r.lease_expires_at<=now()))
        and r.due_at<=now()
      order by r.due_at asc
      for update skip locked
      limit greatest(1,least(coalesce(p_limit,10),20))
  )
  update public.prospect_sms_tour_reminders r set
    status='processing', lease_owner=p_worker_id,
    lease_expires_at=now()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,120),300))),
    updated_at=now()
  from candidates c where r.id=c.id
  returning r.*;
end; $$;

create or replace function public.complete_prospect_sms_tour_reminder(
  p_reminder_id uuid,
  p_worker_id text,
  p_status text,
  p_outbox_id uuid default null,
  p_reason text default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_status not in ('enqueued','scheduled','cancelled','blocked') then return false; end if;
  update public.prospect_sms_tour_reminders set
    status=p_status,
    outbox_id=case when p_status='enqueued' then p_outbox_id else outbox_id end,
    blocked_reason=case when p_status in ('cancelled','blocked') then nullif(trim(p_reason),'') else null end,
    due_at=case when p_status='scheduled' then now()+interval '5 minutes' else due_at end,
    lease_owner=null, lease_expires_at=null, updated_at=now()
  where id=p_reminder_id and status='processing' and lease_owner=p_worker_id
  returning id into v_id;
  return v_id is not null;
end; $$;

-- Final dispatch fence. A queued/deferred reminder is not authorized forever:
-- lock the attempt, burst revision and outbox immediately before the provider
-- no-retry boundary so a newer inbound committed first always wins.
create or replace function public.begin_prospect_tour_reminder_submission(
  p_reminder_id uuid,
  p_outbox_id uuid,
  p_outbox_worker_id text,
  p_attempt_id uuid,
  p_dispatch_started_at timestamptz
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reminder public.prospect_sms_tour_reminders;
  v_burst public.prospect_sms_bursts;
  v_outbox public.sms_outbox;
begin
  select * into v_reminder from public.prospect_sms_tour_reminders
    where id=p_reminder_id for update;
  if not found then return 'unavailable'; end if;
  select * into v_burst from public.prospect_sms_bursts
    where id=v_reminder.burst_id for update;
  perform pg_advisory_xact_lock(hashtextextended('tour-interest:' || v_reminder.manager_user_id::text,0));
  select * into v_outbox from public.sms_outbox
    where id=p_outbox_id for update;
  if not found or v_outbox.status<>'claimed'
    or v_outbox.lease_owner<>p_outbox_worker_id
    or v_outbox.lease_expires_at<=p_dispatch_started_at
    or v_outbox.prospect_tour_reminder_id<>v_reminder.id then
    return 'unavailable';
  end if;
  if v_reminder.status<>'enqueued'
    or v_burst.id is null or v_burst.revision<>v_reminder.burst_revision
    or not exists (
      select 1 from public.prospect_tour_scheduling_state s
      where s.id=v_reminder.scheduling_state_id
        and s.revision=v_reminder.scheduling_state_revision
        and s.status in ('collecting','offered')
    ) then
    update public.sms_outbox set status='blocked',
      blocked_reason='prospect_tour_reminder_stale',lease_owner=null,
      lease_expires_at=null,updated_at=now() where id=p_outbox_id;
    update public.prospect_sms_tour_reminders set status='cancelled',
      blocked_reason='attempt_no_longer_current',updated_at=now()
      where id=p_reminder_id;
    update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now()
      where id=p_attempt_id and outbox_id=p_outbox_id;
    return 'stale';
  end if;
  -- The newer shared reminder system may also have materialized its legacy
  -- manager-opt-in 24-hour tour-interest follow-up. Honor its archive control
  -- and arbitrate both queues under the lock used by its own provider fence so
  -- exactly one follow-up can cross submission.
  if to_regclass('public.manager_tour_followup_controls') is not null then
    if exists(select 1 from public.manager_tour_followup_controls
      where manager_user_id=v_reminder.manager_user_id and conversation_key=v_reminder.conversation_key and archived) then
      update public.sms_outbox set status='blocked',blocked_reason='tour_followup_archived',lease_owner=null,lease_expires_at=null,updated_at=now()
        where id=p_outbox_id;
      update public.prospect_sms_tour_reminders set status='cancelled',blocked_reason='tour_followup_archived',updated_at=now()
        where id=p_reminder_id;
      return 'stale';
    end if;
  end if;
  if to_regclass('public.portal_reminder_records') is not null and exists(
    select 1 from public.sms_outbox o join public.portal_reminder_records r
      on o.dedupe_key='tour-interest:'||r.id::text
    where r.manager_user_id=v_reminder.manager_user_id and r.kind='tour_interest'
      and r.payload->>'conversationKey'=v_reminder.conversation_key
      and o.recipient_phone=v_reminder.recipient_phone_e164
      and (o.dispatch_started_at is not null or o.provider_message_sid is not null
        or o.status in ('submitting','submitted','sent','delivered','unknown'))
  ) then
    update public.sms_outbox set status='blocked',blocked_reason='tour_followup_already_submitted',lease_owner=null,lease_expires_at=null,updated_at=now()
      where id=p_outbox_id;
    update public.prospect_sms_tour_reminders set status='cancelled',blocked_reason='tour_followup_already_submitted',updated_at=now()
      where id=p_reminder_id;
    return 'stale';
  end if;
  if to_regclass('public.portal_reminder_records') is not null then
    update public.sms_outbox o set status='blocked',blocked_reason='superseded_by_two_hour_tour_followup',
      lease_owner=null,lease_expires_at=null,updated_at=now()
      from public.portal_reminder_records r
      where r.manager_user_id=v_reminder.manager_user_id and r.kind='tour_interest'
        and r.payload->>'conversationKey'=v_reminder.conversation_key
        and o.dedupe_key='tour-interest:'||r.id::text and o.recipient_phone=v_reminder.recipient_phone_e164
        and o.status in ('queued','deferred','claimed','blocked') and o.dispatch_started_at is null and o.provider_message_sid is null;
    update public.portal_reminder_records set status='cancelled',lease_owner=null,lease_expires_at=null,updated_at=now()
      where manager_user_id=v_reminder.manager_user_id and kind='tour_interest'
        and payload->>'conversationKey'=v_reminder.conversation_key and status in ('scheduled','sending','sent');
  end if;
  update public.sms_outbox set status='submitting',
    dispatch_started_at=p_dispatch_started_at,updated_at=p_dispatch_started_at
    where id=p_outbox_id;
  return 'started';
end; $$;

alter table public.prospect_sms_tour_reminders enable row level security;
revoke all on table public.prospect_sms_tour_reminders from anon, authenticated;
grant select, insert, update, delete on table public.prospect_sms_tour_reminders to service_role;
revoke execute on function public.cancel_superseded_prospect_tour_reminder() from public, anon, authenticated;
revoke execute on function public.register_prospect_sms_tour_reminder(uuid,integer,uuid,text,text,text,text) from public, anon, authenticated;
revoke execute on function public.claim_prospect_sms_tour_reminders(text,integer,integer) from public, anon, authenticated;
revoke execute on function public.complete_prospect_sms_tour_reminder(uuid,text,text,uuid,text) from public, anon, authenticated;
revoke execute on function public.begin_prospect_tour_reminder_submission(uuid,uuid,text,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.register_prospect_sms_tour_reminder(uuid,integer,uuid,text,text,text,text) to service_role;
grant execute on function public.claim_prospect_sms_tour_reminders(text,integer,integer) to service_role;
grant execute on function public.complete_prospect_sms_tour_reminder(uuid,text,text,uuid,text) to service_role;
grant execute on function public.begin_prospect_tour_reminder_submission(uuid,uuid,text,uuid,timestamptz) to service_role;
