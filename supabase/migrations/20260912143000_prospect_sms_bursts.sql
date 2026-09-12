-- Durable, service-only coordination for prospect SMS.  A source receipt is
-- claimed once and contributes to one revisioned conversation burst.
create table if not exists public.prospect_sms_bursts (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  counterparty_phone_e164 text not null,
  counterparty_role text not null check (counterparty_role = 'prospect'),
  -- Conversation channel, deliberately independent of the ingress transport.
  channel text not null check (channel in ('sms', 'voice')),
  reply_from_number text,
  revision integer not null default 1,
  handled_revision integer not null default 0,
  status text not null default 'queued' check (status in ('queued','generating','prepared','suppressed','dispatched','failed')),
  due_at timestamptz not null,
  lease_owner text,
  lease_expires_at timestamptz,
  queue_job_id text,
  published_at timestamptz,
  -- The latest receipt in a burst chooses its reply rail. This is server
  -- derived at ingress and retained through the delayed worker.
  reply_transport text not null default 'twilio' check (reply_transport in ('twilio', 'claw')),
  shared_catalog boolean not null default false,
  consumed_source_ids jsonb not null default '[]'::jsonb,
  -- Bounded successful tool facts from the last reply that crossed the
  -- submitting boundary. Candidate context is never conversation history.
  history_snapshot jsonb,
  candidate_context jsonb,
  candidate_shadow_snapshot jsonb,
  candidate_body text,
  outbox_id uuid references public.sms_outbox(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manager_user_id, counterparty_phone_e164, counterparty_role, channel)
);

create table if not exists public.prospect_sms_ingress (
  source_message_id text primary key,
  burst_id uuid not null references public.prospect_sms_bursts(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('twilio', 'claw')),
  burst_revision integer not null,
  body text not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.prospect_sms_inline_actions (
  id uuid primary key default gen_random_uuid(),
  burst_id uuid not null references public.prospect_sms_bursts(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  burst_revision integer not null,
  tool_call_id text not null,
  tool_name text not null,
  authorized_at timestamptz not null default now(),
  -- One externally visible action at most for a revision. Model retries may
  -- mint a different call id, so call-id uniqueness alone is not a fence.
  unique (burst_id, burst_revision)
);
create table if not exists public.prospect_sms_shadow_jobs (
  burst_id uuid not null references public.prospect_sms_bursts(id) on delete cascade,
  burst_revision integer not null,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending','running','completed','unknown')),
  lease_owner text,
  lease_expires_at timestamptz,
  result_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (burst_id, burst_revision)
);
create index if not exists prospect_sms_bursts_due_idx on public.prospect_sms_bursts (due_at) where status = 'queued';
create index if not exists prospect_sms_bursts_lease_idx on public.prospect_sms_bursts (lease_expires_at) where status = 'generating';
create index if not exists prospect_sms_ingress_burst_revision_idx
  on public.prospect_sms_ingress (burst_id, burst_revision, received_at);

alter table public.sms_outbox
  add column if not exists prospect_burst_id uuid references public.prospect_sms_bursts(id) on delete set null,
  add column if not exists prospect_burst_revision integer,
  add column if not exists prospect_burst_worker_id text,
  add column if not exists transport text not null default 'twilio' check (transport in ('twilio', 'claw')),
  add column if not exists transport_from_number text;
create unique index if not exists sms_outbox_prospect_burst_revision_uniq
  on public.sms_outbox(prospect_burst_id, prospect_burst_revision)
  where prospect_burst_id is not null;

create or replace function public.record_prospect_sms_ingress(
  p_source_message_id text, p_manager_user_id uuid, p_counterparty_phone_e164 text,
  p_channel text, p_body text, p_reply_from_number text default null, p_quiet_seconds integer default 20
) returns table (burst_id uuid, revision integer, inserted boolean, due_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_burst public.prospect_sms_bursts; v_inserted integer; v_revision integer;
begin
  if coalesce(trim(p_source_message_id),'') = '' or p_manager_user_id is null
    or coalesce(trim(p_counterparty_phone_e164),'') = '' or p_channel not in ('twilio','claw') then
    raise exception 'invalid prospect sms ingress';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_manager_user_id::text || ':sms:' || p_counterparty_phone_e164, 0));
  select b.* into v_burst from public.prospect_sms_ingress i
    join public.prospect_sms_bursts b on b.id = i.burst_id
    where i.source_message_id = p_source_message_id;
  if found then
    return query select v_burst.id, v_burst.revision, false, v_burst.due_at;
    return;
  end if;
  select * into v_burst from public.prospect_sms_bursts
    where manager_user_id = p_manager_user_id and counterparty_phone_e164 = p_counterparty_phone_e164
      and counterparty_role = 'prospect' and channel = 'sms' for update;
  if not found then
    insert into public.prospect_sms_bursts(manager_user_id,counterparty_phone_e164,counterparty_role,channel,reply_from_number,due_at)
    values (p_manager_user_id,p_counterparty_phone_e164,'prospect','sms',p_reply_from_number,now()+make_interval(secs => greatest(1,least(p_quiet_seconds,300))))
    returning * into v_burst;
  end if;
  -- Reserve a revision before recording the source. The source is therefore
  -- always part of the exact snapshot a worker claims, even across restarts.
  update public.prospect_sms_bursts set revision = v_burst.revision + 1,
    -- Preserve a live worker lease. Its revision is now stale and cannot
    -- dispatch; a replacement may claim only once that lease expires.
    status = case when status = 'generating' and lease_expires_at > now() then 'generating' else 'queued' end,
    due_at = now()+make_interval(secs => greatest(1,least(p_quiet_seconds,300))),
    lease_owner = case when status = 'generating' and lease_expires_at > now() then lease_owner else null end,
    lease_expires_at = case when status = 'generating' and lease_expires_at > now() then lease_expires_at else null end,
    queue_job_id = null, published_at = null, candidate_body = null,
    candidate_context = null, candidate_shadow_snapshot = null, outbox_id = null,
    reply_from_number = coalesce(p_reply_from_number, reply_from_number),
    reply_transport = p_channel,
    shared_catalog = (p_channel = 'claw'),
    updated_at = now() where id = v_burst.id returning * into v_burst;
  v_revision := v_burst.revision;
  insert into public.prospect_sms_ingress(source_message_id,burst_id,manager_user_id,channel,burst_revision,body)
  values (p_source_message_id,v_burst.id,p_manager_user_id,p_channel,v_revision,left(p_body,2000)) on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then raise exception 'prospect ingress source insert unexpectedly conflicted'; end if;
  return query select v_burst.id, v_revision, true, v_burst.due_at;
end; $$;

create or replace function public.claim_prospect_sms_burst(p_burst_id uuid, p_revision integer, p_worker_id text, p_lease_seconds integer default 120)
returns table (claimed boolean, source_ids jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids jsonb;
begin
  select coalesce(jsonb_agg(i.source_message_id order by i.received_at),'[]'::jsonb) into v_ids
  from public.prospect_sms_ingress i where i.burst_id = p_burst_id and i.burst_revision <= p_revision
    and i.burst_revision > (select handled_revision from public.prospect_sms_bursts where id = p_burst_id);
  update public.prospect_sms_bursts set status='generating', lease_owner=p_worker_id,
    lease_expires_at=now()+make_interval(secs => greatest(30,least(p_lease_seconds,300))),
    consumed_source_ids=v_ids, updated_at=now()
  where id=p_burst_id and revision=p_revision and due_at <= now()
    and (status in ('queued','failed') or (status='generating' and lease_expires_at <= now()))
  returning true, v_ids into claimed, source_ids;
  return next;
end; $$;

create or replace function public.complete_prospect_sms_burst(p_burst_id uuid, p_revision integer, p_worker_id text, p_status text, p_outbox_id uuid default null, p_candidate_body text default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_manager_user_id uuid;
begin
  if p_status not in ('suppressed','dispatched','failed') then raise exception 'invalid prospect burst completion'; end if;
  -- A superseded worker cannot publish. Release only its own old lease so the
  -- current revision can run as soon as the quiet window is due.
  update public.prospect_sms_bursts set status='queued', lease_owner=null, lease_expires_at=null, updated_at=now()
  where id=p_burst_id and revision <> p_revision and status='generating' and lease_owner=p_worker_id;
  if found then return false; end if;
  update public.prospect_sms_bursts set status=case when p_status='failed' then 'queued' else p_status end,
    handled_revision=case when p_status = 'failed' then handled_revision else p_revision end,
    outbox_id=coalesce(p_outbox_id,outbox_id), candidate_body=p_candidate_body,
    due_at=case when p_status='failed' then now() else due_at end,
    lease_owner=null, lease_expires_at=null, updated_at=now()
  where id=p_burst_id and revision=p_revision and status='generating' and lease_owner=p_worker_id and lease_expires_at > now()
  returning id into v_id;
  return v_id is not null;
end; $$;

create or replace function public.authorize_prospect_sms_inline_action(
  p_burst_id uuid, p_revision integer, p_worker_id text, p_tool_call_id text, p_tool_name text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_manager_user_id uuid;
begin
  if coalesce(trim(p_tool_call_id),'')='' or coalesce(trim(p_tool_name),'')='' then return false; end if;
  select manager_user_id into v_manager_user_id from public.prospect_sms_bursts where id=p_burst_id and revision=p_revision
    and status='generating' and lease_owner=p_worker_id and lease_expires_at>now() for update;
  if not found then return false; end if;
  insert into public.prospect_sms_inline_actions(burst_id,manager_user_id,burst_revision,tool_call_id,tool_name)
    values (p_burst_id,v_manager_user_id,p_revision,p_tool_call_id,p_tool_name)
    on conflict do nothing returning id into v_id;
  return v_id is not null;
end; $$;

-- Release only a known pre-side-effect rejection so the same model turn may
-- correct valid business input. Success and unknown outcomes remain claimed.
create or replace function public.release_prospect_sms_inline_action(
  p_burst_id uuid, p_revision integer, p_worker_id text, p_tool_call_id text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform 1 from public.prospect_sms_bursts where id=p_burst_id and revision=p_revision
    and status='generating' and lease_owner=p_worker_id and lease_expires_at>now() for update;
  if not found then return false; end if;
  delete from public.prospect_sms_inline_actions
    where burst_id=p_burst_id and burst_revision=p_revision and tool_call_id=p_tool_call_id
    returning id into v_id;
  return v_id is not null;
end; $$;

-- The outbox cannot be claimable before its originating burst is prepared.
-- Keeping both writes in this transaction also means a process crash leaves
-- neither a stranded pre-prepare row nor a worker-specific orphan to adopt.
create or replace function public.prepare_prospect_sms_delivery(
  p_burst_id uuid, p_revision integer, p_worker_id text,
  p_manager_user_id uuid, p_actor_user_id uuid, p_recipient_user_id uuid,
  p_recipient_email text, p_recipient_phone text, p_body text, p_send_class text,
  p_purpose text, p_conversation_key text, p_counterparty_role text, p_property_id text,
  p_recipient_timezone text, p_dedupe_key text, p_trace_id text, p_segment_count integer,
  p_status text, p_available_at timestamptz, p_blocked_reason text,
  p_transport text, p_transport_from_number text,
  p_candidate_context jsonb default null, p_candidate_shadow_snapshot jsonb default null
) returns table (outbox_id uuid, status text, deduplicated boolean, prepared boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_burst public.prospect_sms_bursts; v_outbox public.sms_outbox;
begin
  if p_status not in ('queued','deferred') or p_transport not in ('twilio','claw') then
    raise exception 'invalid prospect outbox preparation';
  end if;
  select * into v_burst from public.prospect_sms_bursts where id=p_burst_id for update;
  if not found or v_burst.revision <> p_revision then return; end if;
  if v_burst.manager_user_id <> p_manager_user_id
    or v_burst.counterparty_phone_e164 <> p_recipient_phone
    or v_burst.reply_transport <> p_transport then
    return;
  end if;

  select * into v_outbox from public.sms_outbox
    where prospect_burst_id=p_burst_id and prospect_burst_revision=p_revision for update;
  if found then
    -- Terminal/uncertain submissions are deliberately never revived. A worker
    -- may only observe an already-prepared, still-sendable intent.
    if v_burst.status='prepared' and v_burst.outbox_id=v_outbox.id
      and v_outbox.status in ('queued','deferred','claimed','submitting','submitted','sent','delivered','unknown') then
      return query select v_outbox.id, v_outbox.status, true, true;
    end if;
    return;
  end if;

  if v_burst.status <> 'generating' or v_burst.lease_owner <> p_worker_id
    or v_burst.lease_expires_at <= now() then return; end if;

  insert into public.sms_outbox(
    manager_user_id,actor_user_id,recipient_user_id,recipient_email,recipient_phone,body,
    send_class,purpose,conversation_key,counterparty_role,property_id,recipient_timezone,
    dedupe_key,trace_id,prospect_burst_id,prospect_burst_revision,prospect_burst_worker_id,
    segment_count,status,available_at,blocked_reason,transport,transport_from_number
  ) values (
    p_manager_user_id,p_actor_user_id,p_recipient_user_id,p_recipient_email,p_recipient_phone,p_body,
    p_send_class,p_purpose,p_conversation_key,p_counterparty_role,p_property_id,p_recipient_timezone,
    p_dedupe_key,p_trace_id,p_burst_id,p_revision,p_worker_id,p_segment_count,p_status,p_available_at,
    p_blocked_reason,p_transport,p_transport_from_number
  ) returning * into v_outbox;

  update public.prospect_sms_bursts as b set status='prepared', outbox_id=v_outbox.id,
    candidate_body=v_outbox.body, candidate_context=p_candidate_context,
    candidate_shadow_snapshot=p_candidate_shadow_snapshot,
    lease_owner=null, lease_expires_at=null, updated_at=now()
  where b.id=p_burst_id and b.revision=p_revision and b.status='generating'
    and b.lease_owner=p_worker_id and b.lease_expires_at>now();
  if not found then raise exception 'prospect burst lease lost during preparation'; end if;
  return query select v_outbox.id, v_outbox.status, false, true;
end; $$;

-- The linearization point for prospect delivery. It locks the outbox and burst
-- together, then moves the outbox to submitting only while the originating
-- revision and worker lease are still current. An inbound committed before
-- this transaction makes the candidate stale; one committed after it belongs
-- to the next burst. Provider submission happens later and can only become a
-- terminal submitted or unknown outcome - DB and Twilio cannot be atomic.
create or replace function public.begin_sms_outbox_submission(
  p_outbox_id uuid,
  p_outbox_worker_id text,
  p_attempt_id uuid,
  p_dispatch_started_at timestamptz,
  p_allowance integer,
  p_legacy_allowance integer,
  p_unit_cents integer,
  p_provider_from_phone text
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_outbox public.sms_outbox; v_burst public.prospect_sms_bursts; v_budget_available boolean; v_burst_id uuid; v_credit jsonb;
begin
  -- Prospect preparation locks burst then outbox. Read the immutable foreign
  -- key first and take locks in that same order here to avoid a prepare/submit
  -- deadlock. The locked-row predicates below still validate every mutable
  -- field after both locks are held.
  select prospect_burst_id into v_burst_id from public.sms_outbox where id=p_outbox_id;
  if not found then return 'unavailable'; end if;
  if v_burst_id is not null then
    select * into v_burst from public.prospect_sms_bursts where id=v_burst_id for update;
    if not found then return 'unavailable'; end if;
  end if;
  select * into v_outbox from public.sms_outbox where id=p_outbox_id for update;
  if not found or v_outbox.status <> 'claimed' or v_outbox.lease_owner <> p_outbox_worker_id
    or v_outbox.lease_expires_at <= p_dispatch_started_at then
    return 'unavailable';
  end if;
  if v_outbox.prospect_burst_id is not null then
    if v_outbox.prospect_burst_id <> v_burst_id
      or v_burst.revision <> v_outbox.prospect_burst_revision
      or v_burst.status <> 'prepared'
      or v_burst.outbox_id <> v_outbox.id then
      update public.sms_outbox set status='blocked', blocked_reason='prospect_burst_stale',
        lease_owner=null, lease_expires_at=null, updated_at=now() where id=p_outbox_id;
      update public.sms_delivery_attempts set state='pre_dispatch_failed', finished_at=now()
        where id=p_attempt_id and outbox_id=p_outbox_id;
      return 'stale';
    end if;
    -- This nested transaction preserves the BURST→OUTBOX lock order. Any
    -- refusal rolls both the credit reservation and campaign allocation back.
    begin
      v_credit := public.reserve_comms_credit(v_outbox.manager_user_id,p_allowance,p_legacy_allowance,
        'sms_outbound:' || v_outbox.id::text,'sms_outbound_segment',v_outbox.segment_count,p_unit_cents,
        jsonb_build_object('outboxId',v_outbox.id));
      if coalesce((v_credit->>'allowed')::boolean,false) is not true then
        raise exception using errcode='P0001', message='credit_' || coalesce(v_credit->>'reason','unavailable');
      end if;
      if coalesce((v_credit->>'duplicate')::boolean,false) and v_credit->>'state' <> 'reserved' then
        raise exception using errcode='P0001', message='credit_already_settled';
      end if;
      select public.spend_sms_segment_budget(v_outbox.segment_count) into v_budget_available;
      if v_budget_available is distinct from true then raise exception using errcode='P0001', message='budget_exhausted'; end if;
      update public.prospect_sms_bursts set status='dispatched', handled_revision=v_burst.revision,
        outbox_id=v_outbox.id, candidate_body=v_outbox.body, lease_owner=null,
        lease_expires_at=null, history_snapshot=v_burst.candidate_context,
        candidate_context=null, candidate_shadow_snapshot=null, updated_at=now() where id=v_burst.id;
      if v_burst.candidate_shadow_snapshot is not null then
        insert into public.prospect_sms_shadow_jobs(burst_id,burst_revision,manager_user_id,snapshot)
        values (v_burst.id,v_burst.revision,v_burst.manager_user_id,v_burst.candidate_shadow_snapshot)
        on conflict (burst_id,burst_revision) do nothing;
      end if;
    exception when sqlstate 'P0001' then return SQLERRM;
      when others then return 'credit_unavailable';
    end;
  end if;
  update public.sms_outbox set status='submitting', dispatch_started_at=p_dispatch_started_at,
    provider_from_phone=p_provider_from_phone,
    updated_at=p_dispatch_started_at where id=p_outbox_id;
  return 'started';
end; $$;

alter table public.prospect_sms_bursts enable row level security;
alter table public.prospect_sms_ingress enable row level security;
alter table public.prospect_sms_inline_actions enable row level security;
alter table public.prospect_sms_shadow_jobs enable row level security;
revoke all on table public.prospect_sms_bursts, public.prospect_sms_ingress, public.prospect_sms_inline_actions, public.prospect_sms_shadow_jobs from anon, authenticated;
revoke execute on function public.record_prospect_sms_ingress(text,uuid,text,text,text,text,integer) from public, anon, authenticated;
revoke execute on function public.claim_prospect_sms_burst(uuid,integer,text,integer) from public, anon, authenticated;
revoke execute on function public.complete_prospect_sms_burst(uuid,integer,text,text,uuid,text) from public, anon, authenticated;
revoke execute on function public.authorize_prospect_sms_inline_action(uuid,integer,text,text,text) from public, anon, authenticated;
revoke execute on function public.release_prospect_sms_inline_action(uuid,integer,text,text) from public, anon, authenticated;
revoke execute on function public.prepare_prospect_sms_delivery(uuid,integer,text,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,integer,text,timestamptz,text,text,text,jsonb,jsonb) from public, anon, authenticated;
revoke execute on function public.begin_sms_outbox_submission(uuid,text,uuid,timestamptz,integer,integer,integer,text) from public, anon, authenticated;
grant execute on function public.record_prospect_sms_ingress(text,uuid,text,text,text,text,integer) to service_role;
grant execute on function public.claim_prospect_sms_burst(uuid,integer,text,integer) to service_role;
grant execute on function public.complete_prospect_sms_burst(uuid,integer,text,text,uuid,text) to service_role;
grant execute on function public.authorize_prospect_sms_inline_action(uuid,integer,text,text,text) to service_role;
grant execute on function public.release_prospect_sms_inline_action(uuid,integer,text,text) to service_role;
grant execute on function public.prepare_prospect_sms_delivery(uuid,integer,text,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,integer,text,timestamptz,text,text,text,jsonb,jsonb) to service_role;
grant execute on function public.begin_sms_outbox_submission(uuid,text,uuid,timestamptz,integer,integer,integer,text) to service_role;
