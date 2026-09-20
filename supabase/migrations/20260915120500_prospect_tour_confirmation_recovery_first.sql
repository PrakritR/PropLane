-- Recovery can create the booking-keyed confirmation before the active burst
-- worker resumes. Attach that existing operation to the worker's burst in the
-- same preparation transaction so history, shadow work, and handled revision
-- are not lost. Migration 120000 is already applied and remains immutable.

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
declare
  v_booking public.prospect_tour_bookings;
  v_outbox public.sms_outbox;
  v_legacy public.sms_outbox;
  v_events jsonb;
  v_event jsonb;
  v_burst public.prospect_sms_bursts;
  v_attach_burst boolean := false;
begin
  if p_booking_id is null or p_manager_user_id is null or p_status not in ('queued','deferred') then
    raise exception 'invalid prospect tour confirmation preparation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select * into v_booking from public.prospect_tour_bookings where id=p_booking_id for update;
  if not found or v_booking.manager_user_id<>p_manager_user_id then
    return query select null::uuid,'blocked'::text,true;
    return;
  end if;
  select coalesce(row_data->'payload','[]'::jsonb) into v_events
    from public.portal_schedule_records where id='axis_admin_planned_events_v1' for update;
  select value into v_event from jsonb_array_elements(coalesce(v_events,'[]'::jsonb)) value
    where value->>'id'=v_booking.planned_event_id;
  if v_booking.status<>'confirmed' or v_event is null or coalesce(v_event->>'canceledAt','')<>''
    or v_event->>'start' is distinct from v_booking.event_snapshot->>'start'
    or v_event->>'end' is distinct from v_booking.event_snapshot->>'end'
    or v_event->>'slotKey' is distinct from v_booking.event_snapshot->>'slotKey' then
    update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now()
      where id=p_booking_id and confirmation_status in ('pending','prepared');
    return query select null::uuid,'blocked'::text,true;
    return;
  end if;
  if p_burst_id is not null then
    if p_burst_id is distinct from v_booking.burst_id or p_burst_revision is distinct from v_booking.burst_revision
      or coalesce(trim(p_burst_worker_id),'')='' or p_transport not in ('twilio','claw') then
      raise exception 'invalid prospect tour confirmation burst';
    end if;
    select * into v_burst from public.prospect_sms_bursts where id=p_burst_id for update;
    v_attach_burst := found and v_burst.revision=p_burst_revision and v_burst.status='generating'
      and v_burst.lease_owner=p_burst_worker_id and v_burst.lease_expires_at>now();
    if not v_attach_burst then return; end if;
  end if;

  select * into v_outbox from public.sms_outbox
    where prospect_tour_booking_confirmation_id=p_booking_id for update;
  if found then
    if v_attach_burst and v_outbox.prospect_burst_id is null then
      update public.sms_outbox set
        prospect_burst_id=p_burst_id,
        prospect_burst_revision=p_burst_revision,
        prospect_burst_worker_id=p_burst_worker_id,
        transport=p_transport,
        transport_from_number=p_transport_from_number,
        updated_at=now()
      where id=v_outbox.id and prospect_burst_id is null;
      if v_outbox.status in ('queued','deferred','claimed') then
        update public.prospect_sms_bursts b set status='prepared',outbox_id=v_outbox.id,
          candidate_body=v_outbox.body,candidate_context=p_candidate_context,
          candidate_shadow_snapshot=p_candidate_shadow_snapshot,
          lease_owner=null,lease_expires_at=null,updated_at=now()
        where b.id=v_burst.id and b.revision=p_burst_revision and b.status='generating'
          and b.lease_owner=p_burst_worker_id and b.lease_expires_at>now();
      else
        update public.prospect_sms_bursts b set
          status=case when v_outbox.status='blocked' then 'suppressed' else 'dispatched' end,
          handled_revision=p_burst_revision,outbox_id=v_outbox.id,candidate_body=v_outbox.body,
          history_snapshot=p_candidate_context,candidate_context=null,candidate_shadow_snapshot=null,
          lease_owner=null,lease_expires_at=null,updated_at=now()
        where b.id=v_burst.id and b.revision=p_burst_revision and b.status='generating'
          and b.lease_owner=p_burst_worker_id and b.lease_expires_at>now();
        if not found then raise exception 'prospect tour confirmation burst lease lost'; end if;
        if p_candidate_shadow_snapshot is not null then
          insert into public.prospect_sms_shadow_jobs(burst_id,burst_revision,manager_user_id,snapshot)
          values(v_burst.id,v_burst.revision,v_burst.manager_user_id,p_candidate_shadow_snapshot)
          on conflict(burst_id,burst_revision) do nothing;
        end if;
      end if;
      if v_outbox.status in ('queued','deferred','claimed') and not found then
        raise exception 'prospect tour confirmation burst lease lost';
      end if;
    end if;
    update public.prospect_tour_bookings set confirmation_outbox_id=v_outbox.id,
      confirmation_status=case when v_outbox.status in ('submitted','sent','delivered') then 'submitted'
        when v_outbox.status in ('blocked','unknown') then 'blocked' else 'prepared' end,updated_at=now()
      where id=p_booking_id;
    return query select v_outbox.id,v_outbox.status,
      (v_outbox.status in ('submitting','submitted','sent','delivered','blocked','unknown'));
    return;
  end if;

  select * into v_legacy from public.sms_outbox where prospect_burst_id=v_booking.burst_id
    and prospect_burst_revision=v_booking.burst_revision for update;
  if found and v_legacy.status in ('submitting','submitted','sent','delivered','unknown') then
    update public.sms_outbox set prospect_tour_booking_confirmation_id=p_booking_id,updated_at=now()
      where id=v_legacy.id and prospect_tour_booking_confirmation_id is null;
    update public.prospect_tour_bookings set confirmation_outbox_id=v_legacy.id,
      confirmation_status=case when v_legacy.status in ('submitted','sent','delivered') then 'submitted' else 'blocked' end,
      updated_at=now() where id=p_booking_id;
    return query select v_legacy.id,v_legacy.status,true;
    return;
  end if;
  if found and v_legacy.status in ('queued','deferred','claimed') then
    update public.sms_outbox set prospect_tour_booking_confirmation_id=p_booking_id,updated_at=now()
      where id=v_legacy.id and prospect_tour_booking_confirmation_id is null;
    update public.prospect_tour_bookings set confirmation_outbox_id=v_legacy.id,
      confirmation_status='prepared',updated_at=now() where id=p_booking_id;
    return query select v_legacy.id,v_legacy.status,false;
    return;
  end if;
  if found then
    update public.sms_outbox o set status='blocked',blocked_reason='prospect_tour_confirmation_superseded',
      lease_owner=null,lease_expires_at=null,updated_at=now() where o.id=v_legacy.id;
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
    update public.prospect_sms_bursts b set status='prepared',outbox_id=v_outbox.id,candidate_body=v_outbox.body,
      candidate_context=p_candidate_context,candidate_shadow_snapshot=p_candidate_shadow_snapshot,
      lease_owner=null,lease_expires_at=null,updated_at=now()
      where b.id=v_burst.id and b.revision=p_burst_revision and b.status='generating'
        and b.lease_owner=p_burst_worker_id and b.lease_expires_at>now();
    if not found then raise exception 'prospect tour confirmation burst lease lost'; end if;
  end if;
  update public.prospect_tour_bookings set confirmation_outbox_id=v_outbox.id,
    confirmation_status='prepared',updated_at=now() where id=p_booking_id;
  return query select v_outbox.id,v_outbox.status,false;
end; $$;

revoke execute on function public.prepare_prospect_tour_booking_confirmation(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,integer,text,timestamptz,text,uuid,integer,text,text,text,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.prepare_prospect_tour_booking_confirmation(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,integer,text,timestamptz,text,uuid,integer,text,text,text,jsonb,jsonb)
  to service_role;
