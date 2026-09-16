-- Make booking confirmation submission the authoritative owner of both the
-- campaign segment budget and the current communication-credit reservation.
-- The structured result prevents a dispatcher from inferring ownership from
-- a claimed row that can acquire burst metadata concurrently.

create or replace function public.begin_prospect_tour_booking_confirmation_submission_v2(
  p_booking_id uuid,
  p_outbox_id uuid,
  p_outbox_worker_id text,
  p_attempt_id uuid,
  p_dispatch_started_at timestamptz,
  p_allowance integer,
  p_legacy_allowance integer,
  p_unit_cents integer,
  p_provider_from_phone text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking public.prospect_tour_bookings;
  v_outbox public.sms_outbox;
  v_burst public.prospect_sms_bursts;
  v_events jsonb;
  v_event jsonb;
  v_budget_available boolean;
  v_credit jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select * into v_booking from public.prospect_tour_bookings where id=p_booking_id for update;
  if not found then return jsonb_build_object('outcome','unavailable','costs_reserved',false); end if;

  -- The booking always owns the burst identity, even when recovery created the
  -- outbox before the normal worker attached burst metadata to it. Locking the
  -- burst before the outbox makes the two preparation orders converge.
  if v_booking.burst_id is not null then
    select * into v_burst from public.prospect_sms_bursts where id=v_booking.burst_id for update;
    if not found then return jsonb_build_object('outcome','unavailable','costs_reserved',false); end if;
  end if;

  select * into v_outbox from public.sms_outbox where id=p_outbox_id for update;
  if not found
    or v_outbox.status is distinct from 'claimed'
    or v_outbox.lease_owner is distinct from p_outbox_worker_id
    or v_outbox.lease_expires_at is null
    or v_outbox.lease_expires_at<=p_dispatch_started_at
    or v_outbox.prospect_tour_booking_confirmation_id is distinct from p_booking_id then
    return jsonb_build_object('outcome','unavailable','costs_reserved',false);
  end if;
  perform 1 from public.sms_delivery_attempts
    where id=p_attempt_id and outbox_id=p_outbox_id and state='submitting';
  if not found then return jsonb_build_object('outcome','unavailable','costs_reserved',false); end if;

  select coalesce(row_data->'payload','[]'::jsonb) into v_events
    from public.portal_schedule_records where id='axis_admin_planned_events_v1' for update;
  select value into v_event from jsonb_array_elements(coalesce(v_events,'[]'::jsonb)) value
    where value->>'id'=v_booking.planned_event_id;
  if v_booking.status is distinct from 'confirmed'
    or v_event is null
    or coalesce(v_event->>'canceledAt','')<>''
    or v_event->>'start' is distinct from v_booking.event_snapshot->>'start'
    or v_event->>'end' is distinct from v_booking.event_snapshot->>'end'
    or v_event->>'slotKey' is distinct from v_booking.event_snapshot->>'slotKey' then
    update public.sms_outbox set status='blocked',blocked_reason='prospect_tour_confirmation_stale',
      lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
    update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now()
      where id=p_booking_id and confirmation_outbox_id=p_outbox_id;
    update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now()
      where id=p_attempt_id and outbox_id=p_outbox_id;
    return jsonb_build_object('outcome','stale','costs_reserved',false);
  end if;

  if v_outbox.prospect_burst_id is not null then
    if v_outbox.prospect_burst_id is distinct from v_booking.burst_id
      or v_outbox.prospect_burst_revision is distinct from v_booking.burst_revision
      or v_burst.revision is distinct from v_booking.burst_revision
      or v_burst.status is distinct from 'prepared'
      or v_burst.outbox_id is distinct from v_outbox.id then
      update public.sms_outbox set status='blocked',blocked_reason='prospect_tour_confirmation_stale',
        lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
      update public.prospect_tour_bookings set confirmation_status='blocked',updated_at=now()
        where id=p_booking_id;
      update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now()
        where id=p_attempt_id and outbox_id=p_outbox_id;
      return jsonb_build_object('outcome','stale','costs_reserved',false);
    end if;
  end if;

  -- Roll back both reservations on any refusal. A retry sees neither a partial
  -- credit debit nor a spent campaign segment.
  begin
    v_credit := public.reserve_comms_credit(
      v_outbox.manager_user_id,
      p_allowance,
      p_legacy_allowance,
      'sms_outbound:' || v_outbox.id::text,
      'sms_outbound_segment',
      v_outbox.segment_count,
      p_unit_cents,
      jsonb_build_object('outboxId',v_outbox.id)
    );
    if coalesce((v_credit->>'allowed')::boolean,false) is not true then
      raise exception using errcode='P0001', message='credit_' || coalesce(v_credit->>'reason','unavailable');
    end if;
    if coalesce((v_credit->>'duplicate')::boolean,false) and v_credit->>'state'<>'reserved' then
      raise exception using errcode='P0001', message='credit_already_settled';
    end if;
    select public.spend_sms_segment_budget(v_outbox.segment_count) into v_budget_available;
    if v_budget_available is distinct from true then
      raise exception using errcode='P0001', message='budget_exhausted';
    end if;

    if v_outbox.prospect_burst_id is not null then
      update public.prospect_sms_bursts set
        status='dispatched',
        handled_revision=v_burst.revision,
        outbox_id=v_outbox.id,
        candidate_body=v_outbox.body,
        lease_owner=null,
        lease_expires_at=null,
        history_snapshot=v_burst.candidate_context,
        candidate_context=null,
        candidate_shadow_snapshot=null,
        updated_at=now()
      where id=v_burst.id;
      if v_burst.candidate_shadow_snapshot is not null then
        insert into public.prospect_sms_shadow_jobs(burst_id,burst_revision,manager_user_id,snapshot)
        values(v_burst.id,v_burst.revision,v_burst.manager_user_id,v_burst.candidate_shadow_snapshot)
        on conflict(burst_id,burst_revision) do nothing;
      end if;
    end if;
  exception
    when sqlstate 'P0001' then
      return jsonb_build_object('outcome',SQLERRM,'costs_reserved',false);
    when others then
      return jsonb_build_object('outcome','credit_unavailable','costs_reserved',false);
  end;

  update public.sms_outbox set
    status='submitting',
    dispatch_started_at=p_dispatch_started_at,
    provider_from_phone=p_provider_from_phone,
    updated_at=p_dispatch_started_at
  where id=p_outbox_id;
  return jsonb_build_object('outcome','started','costs_reserved',true);
end; $$;

-- Preserve the current eight-argument communication-credit submission path,
-- but redirect any row with a committed booking before it can cross the
-- mutable burst-only fence. The booking-specific v2 function owns costs.
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
declare
  v_outbox public.sms_outbox;
  v_burst public.prospect_sms_bursts;
  v_booking_id uuid;
  v_budget_available boolean;
  v_burst_id uuid;
  v_burst_revision integer;
  v_credit jsonb;
begin
  select prospect_burst_id,prospect_burst_revision
    into v_burst_id,v_burst_revision from public.sms_outbox where id=p_outbox_id;
  if not found then return 'unavailable'; end if;
  if v_burst_id is not null then
    select id into v_booking_id from public.prospect_tour_bookings
      where burst_id=v_burst_id and burst_revision=v_burst_revision for update;
    select * into v_burst from public.prospect_sms_bursts where id=v_burst_id for update;
    if not found then return 'unavailable'; end if;
  end if;
  select * into v_outbox from public.sms_outbox where id=p_outbox_id for update;
  if not found
    or v_outbox.status<>'claimed'
    or v_outbox.lease_owner<>p_outbox_worker_id
    or v_outbox.lease_expires_at<=p_dispatch_started_at then
    return 'unavailable';
  end if;
  if v_booking_id is not null then
    update public.sms_outbox set prospect_tour_booking_confirmation_id=v_booking_id,updated_at=now()
      where id=p_outbox_id and prospect_tour_booking_confirmation_id is null;
    update public.prospect_tour_bookings set
      confirmation_outbox_id=p_outbox_id,
      confirmation_status='prepared',
      updated_at=now()
    where id=v_booking_id;
    return 'booking_required';
  end if;
  if v_outbox.prospect_burst_id is not null then
    if v_outbox.prospect_burst_id<>v_burst_id
      or v_burst.revision<>v_outbox.prospect_burst_revision
      or v_burst.status<>'prepared'
      or v_burst.outbox_id<>v_outbox.id then
      update public.sms_outbox set status='blocked',blocked_reason='prospect_burst_stale',
        lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_outbox_id;
      update public.sms_delivery_attempts set state='pre_dispatch_failed',finished_at=now()
        where id=p_attempt_id and outbox_id=p_outbox_id;
      return 'stale';
    end if;
    begin
      v_credit := public.reserve_comms_credit(
        v_outbox.manager_user_id,p_allowance,p_legacy_allowance,
        'sms_outbound:' || v_outbox.id::text,'sms_outbound_segment',
        v_outbox.segment_count,p_unit_cents,jsonb_build_object('outboxId',v_outbox.id)
      );
      if coalesce((v_credit->>'allowed')::boolean,false) is not true then
        raise exception using errcode='P0001', message='credit_' || coalesce(v_credit->>'reason','unavailable');
      end if;
      if coalesce((v_credit->>'duplicate')::boolean,false) and v_credit->>'state'<>'reserved' then
        raise exception using errcode='P0001', message='credit_already_settled';
      end if;
      select public.spend_sms_segment_budget(v_outbox.segment_count) into v_budget_available;
      if v_budget_available is distinct from true then
        raise exception using errcode='P0001', message='budget_exhausted';
      end if;
      update public.prospect_sms_bursts set
        status='dispatched',handled_revision=v_burst.revision,outbox_id=v_outbox.id,
        candidate_body=v_outbox.body,lease_owner=null,lease_expires_at=null,
        history_snapshot=v_burst.candidate_context,candidate_context=null,
        candidate_shadow_snapshot=null,updated_at=now()
      where id=v_burst.id;
      if v_burst.candidate_shadow_snapshot is not null then
        insert into public.prospect_sms_shadow_jobs(burst_id,burst_revision,manager_user_id,snapshot)
        values(v_burst.id,v_burst.revision,v_burst.manager_user_id,v_burst.candidate_shadow_snapshot)
        on conflict(burst_id,burst_revision) do nothing;
      end if;
    exception
      when sqlstate 'P0001' then return SQLERRM;
      when others then return 'credit_unavailable';
    end;
  end if;
  update public.sms_outbox set
    status='submitting',dispatch_started_at=p_dispatch_started_at,
    provider_from_phone=p_provider_from_phone,updated_at=p_dispatch_started_at
  where id=p_outbox_id;
  return 'started';
end; $$;

revoke execute on function public.begin_prospect_tour_booking_confirmation_submission_v2(
  uuid,uuid,text,uuid,timestamptz,integer,integer,integer,text
) from public, anon, authenticated;
grant execute on function public.begin_prospect_tour_booking_confirmation_submission_v2(
  uuid,uuid,text,uuid,timestamptz,integer,integer,integer,text
) to service_role;

revoke execute on function public.begin_sms_outbox_submission(
  uuid,text,uuid,timestamptz,integer,integer,integer,text
) from public, anon, authenticated;
grant execute on function public.begin_sms_outbox_submission(
  uuid,text,uuid,timestamptz,integer,integer,integer,text
) to service_role;

-- The immutable cleanup migration introduced the historical five-argument
-- overload. It remains available only to service_role and is not used by the
-- integrated dispatcher.
revoke execute on function public.begin_sms_outbox_submission(
  uuid,text,uuid,timestamptz,integer
) from public, anon, authenticated;
grant execute on function public.begin_sms_outbox_submission(
  uuid,text,uuid,timestamptz,integer
) to service_role;
