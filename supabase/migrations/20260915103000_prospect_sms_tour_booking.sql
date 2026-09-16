-- Autonomous prospect-SMS tours need a relational, retry-safe booking spine.
-- The legacy calendar payload remains the read model, but all confirmed-tour
-- mutations below lock and update it inside one transaction.

create table if not exists public.prospect_tour_scheduling_state (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_key text not null,
  property_id text not null,
  room_id text,
  contact_name text,
  contact_email text,
  trusted_phone_e164 text not null,
  selected_offer jsonb,
  booking_event_id text,
  status text not null default 'collecting'
    check (status in ('collecting','offered','booked','cancelled','handoff','opted_out','deferred')),
  revision integer not null default 1,
  last_inbound_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manager_user_id, conversation_key, property_id)
);

create table if not exists public.tour_slot_reservations (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  property_id text,
  slot_key text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  planned_event_id text not null,
  status text not null default 'active' check (status in ('active','cancelled','rescheduled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manager_user_id, slot_key)
);

create table if not exists public.prospect_tour_bookings (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  scheduling_state_id uuid references public.prospect_tour_scheduling_state(id) on delete set null,
  idempotency_key text not null unique,
  planned_event_id text not null unique,
  burst_id uuid not null references public.prospect_sms_bursts(id) on delete cascade,
  burst_revision integer not null,
  offer_snapshot jsonb not null,
  event_snapshot jsonb not null,
  confirmation_body text not null,
  confirmation_outbox_id uuid references public.sms_outbox(id) on delete set null,
  confirmation_status text not null default 'pending'
    check (confirmation_status in ('pending','prepared','submitted','blocked')),
  manager_notification_status text not null default 'pending'
    check (manager_notification_status in ('pending','completed','suppressed')),
  calendar_sync_status text not null default 'pending'
    check (calendar_sync_status in ('pending','completed','skipped')),
  manager_notification_error text,
  calendar_sync_error text,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','rescheduled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (burst_id, burst_revision)
);

create index if not exists prospect_tour_scheduling_state_conversation_idx
  on public.prospect_tour_scheduling_state(manager_user_id, conversation_key, updated_at desc);
create index if not exists tour_slot_reservations_active_idx
  on public.tour_slot_reservations(manager_user_id, starts_at) where status = 'active';

-- Persist canonical scheduling facts only while the exact inbound worker lease
-- is current. The burst row lock makes a concurrent newer inbound revision
-- wait, and terminal states can never be recreated or downgraded.
create or replace function public.merge_prospect_sms_tour_context(
  p_manager_user_id uuid, p_conversation_key text, p_trusted_phone_e164 text,
  p_property_id text, p_room_id text, p_contact_name text, p_contact_email text,
  p_constraints jsonb, p_burst_id uuid, p_burst_revision integer, p_worker_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_property_id text := nullif(trim(p_property_id),''); v_state public.prospect_tour_scheduling_state; v_active_count integer;
begin
  perform 1 from public.prospect_sms_bursts
    where id=p_burst_id and revision=p_burst_revision and manager_user_id=p_manager_user_id
      and counterparty_phone_e164=p_trusted_phone_e164 and status='generating'
      and lease_owner=p_worker_id and lease_expires_at>now() for update;
  if not found then return jsonb_build_object('ok',false,'reason','stale_worker'); end if;
  perform pg_advisory_xact_lock(hashtextextended('proplane:prospect-tour-context:' || p_manager_user_id::text || ':' || p_conversation_key,0));
  if v_property_id is null then
    select count(*), min(property_id) into v_active_count,v_property_id
      from public.prospect_tour_scheduling_state
      where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key and status in ('collecting','offered');
    if v_active_count<>1 then return jsonb_build_object('ok',false,'reason','ambiguous_property'); end if;
  end if;
  select * into v_state from public.prospect_tour_scheduling_state
    where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key and property_id=v_property_id for update;
  if found and v_state.status not in ('collecting','offered') then
    return jsonb_build_object('ok',false,'reason','terminal_scheduling_state');
  end if;
  update public.prospect_tour_scheduling_state set status='cancelled',selected_offer=null,updated_at=now()
    where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key
      and property_id<>v_property_id and status in ('collecting','offered');
  insert into public.prospect_tour_scheduling_state(
    manager_user_id,conversation_key,property_id,room_id,contact_name,contact_email,
    trusted_phone_e164,selected_offer,status,last_inbound_at
  ) values(
    p_manager_user_id,p_conversation_key,v_property_id,nullif(trim(p_room_id),''),nullif(trim(p_contact_name),''),
    nullif(trim(p_contact_email),''),p_trusted_phone_e164,
    case when p_constraints is null then null else jsonb_build_object('constraints',p_constraints) end,
    'collecting',now()
  ) on conflict(manager_user_id,conversation_key,property_id) do update set
    room_id=coalesce(excluded.room_id,public.prospect_tour_scheduling_state.room_id),
    contact_name=coalesce(excluded.contact_name,public.prospect_tour_scheduling_state.contact_name),
    contact_email=coalesce(excluded.contact_email,public.prospect_tour_scheduling_state.contact_email),
    trusted_phone_e164=excluded.trusted_phone_e164,
    selected_offer=case when p_constraints is null then public.prospect_tour_scheduling_state.selected_offer
      else coalesce(public.prospect_tour_scheduling_state.selected_offer,'{}'::jsonb) || jsonb_build_object('constraints',p_constraints) end,
    last_inbound_at=now(),updated_at=now()
  where public.prospect_tour_scheduling_state.status in ('collecting','offered')
  returning * into v_state;
  if not found then return jsonb_build_object('ok',false,'reason','terminal_scheduling_state'); end if;
  return jsonb_build_object('ok',true,'stateId',v_state.id);
end; $$;

create or replace function public.prepare_prospect_sms_tour_offer(
  p_manager_user_id uuid, p_conversation_key text, p_property_id text,
  p_trusted_phone_e164 text, p_contact_name text, p_contact_email text,
  p_offer jsonb, p_burst_id uuid, p_burst_revision integer, p_worker_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_state public.prospect_tour_scheduling_state;
begin
  perform 1 from public.prospect_sms_bursts
    where id=p_burst_id and revision=p_burst_revision
      and manager_user_id=p_manager_user_id
      and counterparty_phone_e164=p_trusted_phone_e164
      and status='generating' and lease_owner=p_worker_id and lease_expires_at>now()
    for update;
  if not found then return jsonb_build_object('ok',false,'reason','stale_offer'); end if;
  if coalesce(trim(p_conversation_key),'')='' or coalesce(trim(p_property_id),'')=''
    or coalesce(trim(p_contact_name),'')='' or p_offer->>'hostUserId'<>p_manager_user_id::text
    or p_offer->>'policy'<>'published_only' or coalesce(p_offer->>'slotKey','')=''
    or coalesce(p_offer->>'start','')='' or coalesce(p_offer->>'end','')='' then
    return jsonb_build_object('ok',false,'reason','invalid_offer');
  end if;
  insert into public.prospect_tour_scheduling_state(
    manager_user_id,conversation_key,property_id,contact_name,contact_email,
    trusted_phone_e164,selected_offer,status,last_inbound_at
  ) values(
    p_manager_user_id,p_conversation_key,p_property_id,trim(p_contact_name),
    nullif(trim(p_contact_email),''),trim(p_trusted_phone_e164),p_offer,'offered',now()
  ) on conflict(manager_user_id,conversation_key,property_id) do update set
    contact_name=excluded.contact_name,
    contact_email=coalesce(excluded.contact_email,public.prospect_tour_scheduling_state.contact_email),
    trusted_phone_e164=excluded.trusted_phone_e164,
    selected_offer=excluded.selected_offer,
    status='offered',
    revision=public.prospect_tour_scheduling_state.revision,
    last_inbound_at=now(),updated_at=now()
  where public.prospect_tour_scheduling_state.status in ('collecting','offered')
  returning * into v_state;
  if not found then return jsonb_build_object('ok',false,'reason','terminal_scheduling_state'); end if;
  return jsonb_build_object('ok',true,'stateId',v_state.id,'stateRevision',v_state.revision);
end; $$;

-- One shared mutation gate for append/cancel/reschedule. It takes a row lock
-- on the global planned-events record before inspecting or replacing its JSON
-- payload, so no caller can lose another caller's write.
create or replace function public.mutate_confirmed_tour_schedule(
  p_operation text,
  p_event jsonb,
  p_remove_inquiry_ids text[] default '{}'::text[],
  p_allow_conflict boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_planned jsonb := '[]'::jsonb;
  v_inquiries jsonb := '[]'::jsonb;
  v_next jsonb;
  v_event_id text := coalesce(nullif(trim(p_event->>'id'),''), '');
  v_manager uuid;
  v_slot_key text;
  v_start timestamptz;
  v_end timestamptz;
  v_exists boolean;
begin
  if p_operation not in ('append','append_event','cancel','delete','replace','patch') or v_event_id = '' then
    raise exception 'invalid tour schedule mutation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select coalesce(row_data->'payload','[]'::jsonb) into v_planned
    from public.portal_schedule_records where id = 'axis_admin_planned_events_v1' for update;
  if not found then v_planned := '[]'::jsonb; end if;
  select coalesce(row_data->'payload','[]'::jsonb) into v_inquiries
    from public.portal_schedule_records where id = 'axis_admin_partner_inquiries_v1' for update;
  if not found then v_inquiries := '[]'::jsonb; end if;

  if p_operation = 'append' then
    v_manager := nullif(p_event->>'managerUserId','')::uuid;
    v_slot_key := nullif(p_event->>'slotKey','');
    v_start := nullif(p_event->>'start','')::timestamptz;
    v_end := nullif(p_event->>'end','')::timestamptz;
    if v_manager is null or v_slot_key is null or v_start is null or v_end is null or v_end <= v_start then
      raise exception 'invalid tour event';
    end if;
    -- A reservation key is the authoritative single-winner fence. The JSON
    -- scan catches legacy confirmed tours that predate this table.
    if exists (select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id and e->>'managerUserId'=v_manager::text and coalesce(e->>'propertyId','')=coalesce(p_event->>'propertyId','') and coalesce(e->>'slotKey','')=v_slot_key and e->>'start'=p_event->>'start' and e->>'end'=p_event->>'end') then
      return jsonb_build_object('ok',true,'idempotent',true,'event',p_event);
    elsif exists (select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id) then
      return jsonb_build_object('ok',false,'reason','event_id_conflict');
    end if;
    if not p_allow_conflict and exists (
      select 1 from jsonb_array_elements(v_planned) e
      where e->>'kind' = 'tour' and coalesce(e->>'canceledAt','') = ''
        and e->>'managerUserId' = v_manager::text
        and (coalesce(e->>'slotKey','') = v_slot_key
          or (nullif(e->>'start','')::timestamptz < v_end and v_start < nullif(e->>'end','')::timestamptz))
    ) then
      return jsonb_build_object('ok',false,'reason','conflict');
    end if;
    if not p_allow_conflict then
      insert into public.tour_slot_reservations(manager_user_id,property_id,slot_key,starts_at,ends_at,planned_event_id)
      values (v_manager, nullif(p_event->>'propertyId',''), v_slot_key, v_start, v_end, v_event_id)
      on conflict (manager_user_id,slot_key) do update set
        property_id=excluded.property_id, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
        planned_event_id=excluded.planned_event_id, status='active', updated_at=now()
      where public.tour_slot_reservations.status in ('cancelled','rescheduled')
        or public.tour_slot_reservations.planned_event_id = excluded.planned_event_id;
      if not found then return jsonb_build_object('ok',false,'reason','conflict'); end if;
    end if;
    v_next := v_planned || jsonb_build_array(p_event);
  elsif p_operation = 'append_event' then
    if exists (select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id and e=p_event) then
      return jsonb_build_object('ok',true,'idempotent',true,'event',p_event);
    elsif exists (select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id) then
      return jsonb_build_object('ok',false,'reason','event_id_conflict');
    end if;
    v_next := v_planned || jsonb_build_array(p_event);
  elsif p_operation = 'cancel' then
    v_exists := exists(select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id and coalesce(e->>'canceledAt','')='');
    if not v_exists then return jsonb_build_object('ok',false,'reason','not_found'); end if;
    v_next := (select coalesce(jsonb_agg(case when e->>'id'=v_event_id then e || jsonb_build_object('canceledAt',now()::text) else e end),'[]'::jsonb) from jsonb_array_elements(v_planned) e);
    update public.tour_slot_reservations set status='cancelled',updated_at=now() where planned_event_id=v_event_id and status='active';
    update public.prospect_tour_bookings set status='cancelled',updated_at=now() where planned_event_id=v_event_id and status in ('confirmed','rescheduled');
  elsif p_operation = 'replace' then
    v_manager := nullif(p_event->>'managerUserId','')::uuid;
    v_slot_key := nullif(p_event->>'slotKey','');
    v_start := nullif(p_event->>'start','')::timestamptz;
    v_end := nullif(p_event->>'end','')::timestamptz;
    if v_manager is null or v_slot_key is null or v_start is null or v_end is null or v_end <= v_start then
      raise exception 'invalid tour event';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_planned) e
      where e->>'id' <> v_event_id and e->>'kind'='tour' and coalesce(e->>'canceledAt','')=''
        and e->>'managerUserId'=v_manager::text
        and (coalesce(e->>'slotKey','')=v_slot_key or (nullif(e->>'start','')::timestamptz < v_end and v_start < nullif(e->>'end','')::timestamptz))
    ) then return jsonb_build_object('ok',false,'reason','conflict'); end if;
    if exists (select 1 from public.tour_slot_reservations where manager_user_id=v_manager and slot_key=v_slot_key and planned_event_id<>v_event_id and status='active') then
      return jsonb_build_object('ok',false,'reason','conflict');
    end if;
    v_next := (select coalesce(jsonb_agg(case when e->>'id'=v_event_id then p_event else e end),'[]'::jsonb) from jsonb_array_elements(v_planned) e);
    v_exists := exists(select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id);
    if not v_exists then return jsonb_build_object('ok',false,'reason','not_found'); end if;
    update public.tour_slot_reservations set status='rescheduled',updated_at=now()
      where planned_event_id=v_event_id and status='active';
    insert into public.tour_slot_reservations(manager_user_id,property_id,slot_key,starts_at,ends_at,planned_event_id,status)
    values(v_manager,nullif(p_event->>'propertyId',''),v_slot_key,v_start,v_end,v_event_id,'active')
    on conflict(manager_user_id,slot_key) do update set
      property_id=excluded.property_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
      planned_event_id=excluded.planned_event_id,status='active',updated_at=now()
    where public.tour_slot_reservations.status in ('cancelled','rescheduled')
      or public.tour_slot_reservations.planned_event_id=excluded.planned_event_id;
    if not found then raise exception 'tour reservation changed concurrently'; end if;
    update public.prospect_tour_bookings set status='confirmed',updated_at=now() where planned_event_id=v_event_id and status in ('confirmed','rescheduled');
  elsif p_operation = 'delete' then
    v_exists := exists(select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id);
    if not v_exists then return jsonb_build_object('ok',false,'reason','not_found'); end if;
    v_next := (select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(v_planned) e where e->>'id'<>v_event_id);
    update public.tour_slot_reservations set status='cancelled',updated_at=now()
      where planned_event_id=v_event_id and status='active';
    update public.prospect_tour_bookings set status='cancelled',updated_at=now()
      where planned_event_id=v_event_id and status in ('confirmed','rescheduled');
  else
    v_next := (select coalesce(jsonb_agg(case when e->>'id'=v_event_id then p_event else e end),'[]'::jsonb) from jsonb_array_elements(v_planned) e);
    v_exists := exists(select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id);
    if not v_exists then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  end if;

  insert into public.portal_schedule_records(id,manager_user_id,property_id,record_type,starts_at,ends_at,row_data,updated_at)
  values ('axis_admin_planned_events_v1',null,null,'axis_admin_planned_events_v1',null,null,jsonb_build_object('id','axis_admin_planned_events_v1','recordType','axis_admin_planned_events_v1','managerUserId',null,'propertyId',null,'payload',v_next),now())
  on conflict (id) do update set row_data=excluded.row_data,updated_at=excluded.updated_at;
  if cardinality(p_remove_inquiry_ids) > 0 then
    v_inquiries := (select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(v_inquiries) e where not (e->>'id' = any(p_remove_inquiry_ids)));
    update public.portal_schedule_records set row_data=jsonb_build_object('id','axis_admin_partner_inquiries_v1','recordType','axis_admin_partner_inquiries_v1','managerUserId',null,'propertyId',null,'payload',v_inquiries),updated_at=now() where id='axis_admin_partner_inquiries_v1';
    delete from public.portal_schedule_records r
      where r.record_type='partner_inquiry_request'
        and exists (select 1 from unnest(p_remove_inquiry_ids) inquiry_id where r.id like 'partner_inquiry_request_' || inquiry_id || '_%');
  end if;
  return jsonb_build_object('ok',true,'event',p_event);
end; $$;

-- SMS-specific wrapper: persists durable attempt/state, creates the relational
-- booking and calls the same shared schedule boundary under one transaction.
create or replace function public.confirm_prospect_sms_tour_offer(
  p_manager_user_id uuid, p_conversation_key text, p_property_id text,
  p_trusted_phone_e164 text, p_contact_name text, p_contact_email text,
  p_offer jsonb, p_event jsonb, p_idempotency_key text,
  p_burst_id uuid, p_burst_revision integer, p_agreement_source_message_id text, p_worker_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_state public.prospect_tour_scheduling_state; v_existing public.prospect_tour_bookings; v_mutation jsonb; v_current_revision integer; v_history jsonb; v_confirmation_body text;
begin
  if p_manager_user_id is null or coalesce(trim(p_conversation_key),'')='' or coalesce(trim(p_property_id),'')='' or coalesce(trim(p_trusted_phone_e164),'')='' or coalesce(trim(p_contact_name),'')='' or coalesce(trim(p_idempotency_key),'')='' or p_burst_id is null or p_burst_revision is null or coalesce(trim(p_agreement_source_message_id),'')='' or coalesce(trim(p_worker_id),'')='' then
    raise exception 'invalid prospect tour booking';
  end if;
  select * into v_existing from public.prospect_tour_bookings
    where idempotency_key=p_idempotency_key and manager_user_id=p_manager_user_id
      and burst_id=p_burst_id and burst_revision=p_burst_revision for update;
  if found then
    if v_existing.status <> 'confirmed' then
      return jsonb_build_object('ok',false,'reason','booking_no_longer_confirmed');
    end if;
    return jsonb_build_object('ok',true,'idempotent',true,'plannedEventId',v_existing.planned_event_id,'status',v_existing.status);
  end if;
  select revision into v_current_revision from public.prospect_sms_bursts where id=p_burst_id and manager_user_id=p_manager_user_id and counterparty_phone_e164=p_trusted_phone_e164 and status='generating' and lease_owner=p_worker_id and lease_expires_at>now() for update;
  if not found or v_current_revision <> p_burst_revision or not exists (select 1 from public.prospect_sms_ingress where burst_id=p_burst_id and burst_revision=p_burst_revision and source_message_id=p_agreement_source_message_id) then
    return jsonb_build_object('ok',false,'reason','stale_agreement');
  end if;
  if p_event->>'kind' <> 'tour' or p_event->>'managerUserId' <> p_manager_user_id::text or p_event->>'adminUserId' <> p_manager_user_id::text or p_event->>'propertyId' <> p_property_id or p_event->>'slotKey' <> p_offer->>'slotKey' or p_event->>'start' <> p_offer->>'start' or p_event->>'end' <> p_offer->>'end' or p_offer->>'hostUserId' <> p_manager_user_id::text or p_offer->>'policy' <> 'published_only' then
    return jsonb_build_object('ok',false,'reason','invalid_offer');
  end if;
  select * into v_state from public.prospect_tour_scheduling_state
    where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key
      and property_id=p_property_id and status='offered'
      and selected_offer->>'slotKey'=p_offer->>'slotKey'
      and selected_offer->>'start'=p_offer->>'start'
      and selected_offer->>'end'=p_offer->>'end'
      and selected_offer->>'hostUserId'=p_offer->>'hostUserId'
    for update;
  if not found then return jsonb_build_object('ok',false,'reason','offer_not_prepared'); end if;
  select history_snapshot into v_history from public.prospect_sms_bursts where id=p_burst_id;
  if not exists (
    select 1 from jsonb_array_elements(coalesce(v_history,'[]'::jsonb)) fact
    where fact->>'tool'='prepare_prospect_tour_confirmation'
      and fact->'input'->>'propertyId'=p_property_id
      and fact->'output'->'preparedOffer'->>'slotKey'=p_offer->>'slotKey'
      and fact->'output'->'preparedOffer'->>'start'=p_offer->>'start'
      and fact->'output'->'preparedOffer'->>'end'=p_offer->>'end'
      and fact->'output'->'preparedOffer'->>'hostUserId'=p_offer->>'hostUserId'
  ) then return jsonb_build_object('ok',false,'reason','offer_not_submitted'); end if;
  v_mutation := public.mutate_confirmed_tour_schedule('append',p_event);
  if coalesce((v_mutation->>'ok')::boolean,false) is not true then return v_mutation; end if;
  v_confirmation_body := 'Tour confirmed for ' || coalesce(nullif(trim(p_offer->>'label'),''), p_offer->>'start') || '.';
  insert into public.prospect_tour_bookings(
    manager_user_id,scheduling_state_id,idempotency_key,planned_event_id,
    burst_id,burst_revision,offer_snapshot,event_snapshot,confirmation_body
  ) values(
    p_manager_user_id,v_state.id,p_idempotency_key,p_event->>'id',
    p_burst_id,p_burst_revision,p_offer,p_event,v_confirmation_body
  );
  update public.prospect_tour_scheduling_state set booking_event_id=p_event->>'id',status='booked',updated_at=now() where id=v_state.id;
  return jsonb_build_object('ok',true,'idempotent',false,'plannedEventId',p_event->>'id','status','confirmed');
end; $$;

alter table public.prospect_tour_scheduling_state enable row level security;
alter table public.tour_slot_reservations enable row level security;
alter table public.prospect_tour_bookings enable row level security;
revoke all on table public.prospect_tour_scheduling_state, public.tour_slot_reservations, public.prospect_tour_bookings from anon, authenticated;
grant select, insert, update, delete on table public.prospect_tour_scheduling_state, public.tour_slot_reservations, public.prospect_tour_bookings to service_role;
revoke execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean) from public, anon, authenticated;
revoke execute on function public.merge_prospect_sms_tour_context(uuid,text,text,text,text,text,text,jsonb,uuid,integer,text) from public, anon, authenticated;
revoke execute on function public.prepare_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,uuid,integer,text) from public, anon, authenticated;
revoke execute on function public.confirm_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean) to service_role;
grant execute on function public.merge_prospect_sms_tour_context(uuid,text,text,text,text,text,text,jsonb,uuid,integer,text) to service_role;
grant execute on function public.prepare_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,uuid,integer,text) to service_role;
grant execute on function public.confirm_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text) to service_role;
