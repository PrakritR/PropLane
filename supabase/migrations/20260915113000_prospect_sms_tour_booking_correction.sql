-- Correctness repair for autonomous prospect-tour booking. Earlier September
-- migrations are applied in dev/test, so this file is strictly additive.

alter table public.sms_outbox
  add column if not exists prospect_tour_booking_confirmation_id uuid
    references public.prospect_tour_bookings(id) on delete set null;
create unique index if not exists sms_outbox_prospect_tour_booking_confirmation_uniq
  on public.sms_outbox(prospect_tour_booking_confirmation_id)
  where prospect_tour_booking_confirmation_id is not null;

-- Update only the current event's Google metadata. This deliberately never
-- accepts a whole stale event object, and rejects a cancel/delete/reschedule
-- that landed after a remote Google write started.
create or replace function public.persist_confirmed_tour_google_calendar_id(
  p_planned_event_id text,
  p_google_calendar_event_id text,
  p_expected_start text,
  p_expected_end text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_events jsonb; v_event jsonb; v_next jsonb;
begin
  if coalesce(trim(p_planned_event_id),'')='' or coalesce(trim(p_expected_start),'')=''
    or coalesce(trim(p_expected_end),'')='' then
    return jsonb_build_object('ok',false,'reason','missing');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select coalesce(row_data->'payload','[]'::jsonb) into v_events
    from public.portal_schedule_records where id='axis_admin_planned_events_v1' for update;
  if not found then return jsonb_build_object('ok',false,'reason','missing'); end if;
  select value into v_event from jsonb_array_elements(v_events) value
    where value->>'id'=trim(p_planned_event_id);
  if not found then return jsonb_build_object('ok',false,'reason','missing'); end if;
  if coalesce(v_event->>'canceledAt','')<>'' then
    return jsonb_build_object('ok',false,'reason','cancelled');
  end if;
  if v_event->>'kind' IS DISTINCT FROM 'tour'
    or v_event->>'start' IS DISTINCT FROM p_expected_start
    or v_event->>'end' IS DISTINCT FROM p_expected_end then
    return jsonb_build_object('ok',false,'reason','changed');
  end if;
  v_next := (
    select coalesce(jsonb_agg(case when value->>'id'=trim(p_planned_event_id) then
      case when nullif(trim(p_google_calendar_event_id),'') is null then value - 'googleCalendarEventId'
      else value || jsonb_build_object('googleCalendarEventId',trim(p_google_calendar_event_id)) end
      else value end), '[]'::jsonb)
    from jsonb_array_elements(v_events) value
  );
  update public.portal_schedule_records set
    row_data=coalesce(row_data,'{}'::jsonb) || jsonb_build_object('payload',v_next),
    updated_at=now()
    where id='axis_admin_planned_events_v1';
  return jsonb_build_object('ok',true);
end; $$;

-- A booking confirmation outlives a mutable conversation burst. Its provider
-- fence rechecks the current booking and live event at the no-retry boundary.
create or replace function public.begin_prospect_tour_booking_confirmation_submission(
  p_booking_id uuid,
  p_outbox_id uuid,
  p_outbox_worker_id text,
  p_attempt_id uuid,
  p_dispatch_started_at timestamptz
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_booking public.prospect_tour_bookings; v_outbox public.sms_outbox; v_events jsonb; v_event jsonb;
begin
  -- Keep the same leading lock as cancel/reschedule. A confirmation delivery
  -- must never wait while holding the booking row that a schedule mutation
  -- needs after taking this advisory lock.
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select * into v_booking from public.prospect_tour_bookings where id=p_booking_id for update;
  select * into v_outbox from public.sms_outbox where id=p_outbox_id for update;
  if not found or v_outbox.status IS DISTINCT FROM 'claimed'
    or v_outbox.lease_owner IS DISTINCT FROM p_outbox_worker_id
    or v_outbox.lease_expires_at is null or v_outbox.lease_expires_at<=p_dispatch_started_at
    or v_outbox.prospect_tour_booking_confirmation_id IS DISTINCT FROM p_booking_id then
    return 'unavailable';
  end if;
  perform 1 from public.sms_delivery_attempts
    where id=p_attempt_id and outbox_id=p_outbox_id and state='submitting';
  if not found then return 'unavailable'; end if;
  select coalesce(row_data->'payload','[]'::jsonb) into v_events
    from public.portal_schedule_records where id='axis_admin_planned_events_v1' for update;
  select value into v_event from jsonb_array_elements(coalesce(v_events,'[]'::jsonb)) value
    where value->>'id'=v_booking.planned_event_id;
  if v_booking.id is null or v_booking.status IS DISTINCT FROM 'confirmed' or v_event is null
    or coalesce(v_event->>'canceledAt','')<>''
    or v_event->>'start' IS DISTINCT FROM v_booking.event_snapshot->>'start'
    or v_event->>'end' IS DISTINCT FROM v_booking.event_snapshot->>'end'
    or v_event->>'slotKey' IS DISTINCT FROM v_booking.event_snapshot->>'slotKey' then
    update public.sms_outbox set status='blocked',blocked_reason='prospect_tour_confirmation_stale',
      lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
    update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now()
      where id=p_booking_id and confirmation_outbox_id=p_outbox_id;
    update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now()
      where id=p_attempt_id and outbox_id=p_outbox_id;
    return 'stale';
  end if;
  update public.sms_outbox set status='submitting',dispatch_started_at=p_dispatch_started_at,
    updated_at=p_dispatch_started_at where id=p_outbox_id;
  return 'started';
end; $$;

-- The original claim sorted only by receipt time. Source ids make same-timestamp
-- snapshots deterministic and match the verification order in the booking RPC.
create or replace function public.claim_prospect_sms_burst(
  p_burst_id uuid, p_revision integer, p_worker_id text, p_lease_seconds integer default 120
) returns table (claimed boolean, source_ids jsonb)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids jsonb;
begin
  select coalesce(jsonb_agg(i.source_message_id order by i.received_at,i.source_message_id),'[]'::jsonb) into v_ids
    from public.prospect_sms_ingress i where i.burst_id=p_burst_id and i.burst_revision<=p_revision
      and i.burst_revision>(select handled_revision from public.prospect_sms_bursts where id=p_burst_id);
  update public.prospect_sms_bursts set status='generating',lease_owner=p_worker_id,
    lease_expires_at=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,300))),
    consumed_source_ids=v_ids,updated_at=now()
    where id=p_burst_id and revision=p_revision and due_at<=now()
      and (status in ('queued','failed') or (status='generating' and lease_expires_at<=now()))
    returning true,v_ids into claimed,source_ids;
  return next;
end; $$;

-- The old signature cannot prove that one source message represented the whole
-- claimed snapshot. The only callable booking path now passes and verifies the
-- exact ordered source list stored by the worker claim.
create or replace function public.confirm_prospect_sms_tour_offer(
  p_manager_user_id uuid, p_conversation_key text, p_property_id text,
  p_trusted_phone_e164 text, p_contact_name text, p_contact_email text,
  p_offer jsonb, p_event jsonb, p_idempotency_key text,
  p_burst_id uuid, p_burst_revision integer, p_agreement_source_message_id text,
  p_claimed_source_ids text[], p_worker_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_state public.prospect_tour_scheduling_state; v_existing public.prospect_tour_bookings;
  v_mutation jsonb; v_history jsonb; v_confirmation_body text; v_burst public.prospect_sms_bursts;
  v_ingress_ids text[];
begin
  if p_manager_user_id is null or coalesce(trim(p_conversation_key),'')='' or coalesce(trim(p_property_id),'')=''
    or coalesce(trim(p_trusted_phone_e164),'')='' or coalesce(trim(p_contact_name),'')=''
    or coalesce(trim(p_idempotency_key),'')='' or p_burst_id is null or p_burst_revision is null
    or coalesce(trim(p_agreement_source_message_id),'')='' or coalesce(trim(p_worker_id),'')=''
    or coalesce(cardinality(p_claimed_source_ids),0)=0 then
    raise exception 'invalid prospect tour booking';
  end if;
  select * into v_existing from public.prospect_tour_bookings
    where idempotency_key=p_idempotency_key and manager_user_id=p_manager_user_id
      and burst_id=p_burst_id and burst_revision=p_burst_revision for update;
  if found then
    if v_existing.status<>'confirmed' then return jsonb_build_object('ok',false,'reason','booking_no_longer_confirmed'); end if;
    return jsonb_build_object('ok',true,'idempotent',true,'plannedEventId',v_existing.planned_event_id,'status',v_existing.status);
  end if;
  select * into v_burst from public.prospect_sms_bursts where id=p_burst_id
    and manager_user_id=p_manager_user_id and counterparty_phone_e164=p_trusted_phone_e164
    and status='generating' and lease_owner=p_worker_id and lease_expires_at>now() for update;
  if not found or v_burst.revision<>p_burst_revision
    or jsonb_typeof(v_burst.consumed_source_ids) IS DISTINCT FROM 'array'
    or v_burst.consumed_source_ids IS DISTINCT FROM to_jsonb(p_claimed_source_ids)
    or cardinality(p_claimed_source_ids)<>(select count(distinct source_id) from unnest(p_claimed_source_ids) source_id)
    or not (p_agreement_source_message_id=any(p_claimed_source_ids)) then
    return jsonb_build_object('ok',false,'reason','stale_agreement');
  end if;
  select array_agg(i.source_message_id order by i.received_at,i.source_message_id) into v_ingress_ids
    from public.prospect_sms_ingress i where i.burst_id=p_burst_id
      and i.source_message_id=any(p_claimed_source_ids);
  if v_ingress_ids is distinct from p_claimed_source_ids then
    return jsonb_build_object('ok',false,'reason','stale_agreement');
  end if;
  if p_event->>'kind' IS DISTINCT FROM 'tour' or p_event->>'managerUserId' IS DISTINCT FROM p_manager_user_id::text
    or p_event->>'adminUserId' IS DISTINCT FROM p_manager_user_id::text or p_event->>'propertyId' IS DISTINCT FROM p_property_id
    or p_event->>'slotKey' IS DISTINCT FROM p_offer->>'slotKey' or p_event->>'start' IS DISTINCT FROM p_offer->>'start'
    or p_event->>'end' IS DISTINCT FROM p_offer->>'end' or p_offer->>'hostUserId' IS DISTINCT FROM p_manager_user_id::text
    or p_offer->>'policy' IS DISTINCT FROM 'published_only' then return jsonb_build_object('ok',false,'reason','invalid_offer'); end if;
  select * into v_state from public.prospect_tour_scheduling_state
    where manager_user_id=p_manager_user_id and conversation_key=p_conversation_key and property_id=p_property_id
      and status='offered' and selected_offer->>'slotKey'=p_offer->>'slotKey'
      and selected_offer->>'start'=p_offer->>'start' and selected_offer->>'end'=p_offer->>'end'
      and selected_offer->>'hostUserId'=p_offer->>'hostUserId' for update;
  if not found then return jsonb_build_object('ok',false,'reason','offer_not_prepared'); end if;
  v_history:=v_burst.history_snapshot;
  if not exists (select 1 from jsonb_array_elements(coalesce(v_history,'[]'::jsonb)) fact
    where fact->>'tool'='prepare_prospect_tour_confirmation' and fact->'input'->>'propertyId'=p_property_id
      and fact->'output'->'preparedOffer'->>'slotKey'=p_offer->>'slotKey'
      and fact->'output'->'preparedOffer'->>'start'=p_offer->>'start'
      and fact->'output'->'preparedOffer'->>'end'=p_offer->>'end'
      and fact->'output'->'preparedOffer'->>'hostUserId'=p_offer->>'hostUserId') then
    return jsonb_build_object('ok',false,'reason','offer_not_submitted');
  end if;
  v_mutation:=public.mutate_confirmed_tour_schedule('append',p_event);
  if coalesce((v_mutation->>'ok')::boolean,false) is not true then return v_mutation; end if;
  v_confirmation_body:='Tour confirmed for '||coalesce(nullif(trim(p_offer->>'label'),''),p_offer->>'start')||'.';
  insert into public.prospect_tour_bookings(manager_user_id,scheduling_state_id,idempotency_key,planned_event_id,
    burst_id,burst_revision,offer_snapshot,event_snapshot,confirmation_body)
    values(p_manager_user_id,v_state.id,p_idempotency_key,p_event->>'id',p_burst_id,p_burst_revision,p_offer,p_event,v_confirmation_body);
  update public.prospect_tour_scheduling_state set booking_event_id=p_event->>'id',status='booked',updated_at=now() where id=v_state.id;
  return jsonb_build_object('ok',true,'idempotent',false,'plannedEventId',p_event->>'id','status','confirmed');
end; $$;

revoke execute on function public.confirm_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text) from service_role;
revoke execute on function public.persist_confirmed_tour_google_calendar_id(text,text,text,text) from public, anon, authenticated;
revoke execute on function public.begin_prospect_tour_booking_confirmation_submission(uuid,uuid,text,uuid,timestamptz) from public, anon, authenticated;
revoke execute on function public.confirm_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text[],text) from public, anon, authenticated;
grant execute on function public.persist_confirmed_tour_google_calendar_id(text,text,text,text) to service_role;
grant execute on function public.begin_prospect_tour_booking_confirmation_submission(uuid,uuid,text,uuid,timestamptz) to service_role;
grant execute on function public.confirm_prospect_sms_tour_offer(uuid,text,text,text,text,text,jsonb,jsonb,text,uuid,integer,text,text[],text) to service_role;
