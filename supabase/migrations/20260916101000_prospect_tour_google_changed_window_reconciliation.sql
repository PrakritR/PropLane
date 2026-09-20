-- A successful stale Google create for a still-live tour is not cleanup work.
-- Keep it reclaimable until the current window has been pushed and the
-- lifecycle-safe Google-id persistence CAS has succeeded.

create or replace function public.settle_prospect_tour_google_calendar_create(
  p_planned_event_id text,
  p_generation uuid,
  p_result text,
  p_error text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_intent public.prospect_tour_google_calendar_create_intents;
  v_event jsonb;
  v_current boolean := false;
begin
  -- Match begin/trigger lock order: schedule row first, then intent.
  select value into v_event from public.portal_schedule_records r,
    lateral jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value
    where r.id='axis_admin_planned_events_v1' and value->>'id'=nullif(trim(p_planned_event_id),'')
    for update;
  select * into v_intent from public.prospect_tour_google_calendar_create_intents
    where planned_event_id = nullif(trim(p_planned_event_id),'') for update;
  if not found or v_intent.generation is distinct from p_generation then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  v_current := v_event is not null and coalesce(v_event->>'canceledAt','')=''
    and (v_event->>'start')::timestamptz is not distinct from v_intent.expected_start
    and (v_event->>'end')::timestamptz is not distinct from v_intent.expected_end;
  if p_result = 'persisted' and v_current then
    update public.prospect_tour_google_calendar_create_intents set
      state='settled', lease_owner=null, lease_expires_at=null, last_error=null,
      settled_at=now(), updated_at=now() where planned_event_id=v_intent.planned_event_id;
    return jsonb_build_object('ok', true, 'state', 'settled');
  end if;
  if p_result = 'cleanup_ready' and v_event is not null and coalesce(v_event->>'canceledAt','')='' then
    -- The provider has returned at the old window, but a live event moved.
    -- Release it directly into the recovery queue, not terminal cleanup.
    update public.prospect_tour_google_calendar_create_intents set
      state='reconcile_current', lease_owner=null, lease_expires_at=null,
      provider_deadline_at=now(), last_error='planned tour changed during Google create',
      settled_at=null, updated_at=now() where planned_event_id=v_intent.planned_event_id;
    return jsonb_build_object('ok', true, 'state', 'reconcile_current');
  end if;
  if p_result = 'cleanup_ready' then
    update public.prospect_tour_google_calendar_create_intents set
      state='reconciled', lease_owner=null, lease_expires_at=null, last_error=null,
      settled_at=now(), updated_at=now() where planned_event_id=v_intent.planned_event_id;
    perform public.enqueue_prospect_tour_google_calendar_cleanup(
      v_intent.manager_user_id, v_intent.planned_event_id, v_intent.google_calendar_event_id
    );
    return jsonb_build_object('ok', true, 'state', 'reconciled');
  end if;
  if v_event is not null and coalesce(v_event->>'canceledAt','')=''
    and p_result = 'reconcile_current' then
    update public.prospect_tour_google_calendar_create_intents set
      state='settled', lease_owner=null, lease_expires_at=null, last_error=null,
      settled_at=now(), updated_at=now() where planned_event_id=v_intent.planned_event_id;
    return jsonb_build_object('ok', true, 'state', 'settled');
  end if;
  update public.prospect_tour_google_calendar_create_intents i set
    state='cleanup_required', lease_owner=null, lease_expires_at=null,
    last_error=coalesce(nullif(trim(p_error),''), case when p_result='persisted' then 'planned tour changed during Google create' else 'Google create outcome unknown' end),
    updated_at=now() where planned_event_id=v_intent.planned_event_id;
  perform public.enqueue_prospect_tour_google_calendar_cleanup(
    v_intent.manager_user_id, v_intent.planned_event_id, v_intent.google_calendar_event_id
  );
  return jsonb_build_object('ok', true, 'state', 'cleanup_required');
end; $$;

-- This is separate from the claimed recovery completion RPC because the
-- original request may finish the follow-up before a sweeper claims it. The
-- expected current window prevents a second move from settling an old patch.
create or replace function public.settle_prospect_tour_google_calendar_current_reconciliation(
  p_planned_event_id text,
  p_generation uuid,
  p_expected_start timestamptz,
  p_expected_end timestamptz
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event jsonb;
begin
  select value into v_event from public.portal_schedule_records r,
    lateral jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value
    where r.id='axis_admin_planned_events_v1' and value->>'id'=nullif(trim(p_planned_event_id),'')
    for update;
  if v_event is null or coalesce(v_event->>'canceledAt','')<>''
    or (v_event->>'start')::timestamptz is distinct from p_expected_start
    or (v_event->>'end')::timestamptz is distinct from p_expected_end then
    return false;
  end if;
  update public.prospect_tour_google_calendar_create_intents set
    state='settled', expected_start=p_expected_start, expected_end=p_expected_end,
    lease_owner=null, lease_expires_at=null, last_error=null, settled_at=now(), updated_at=now()
    where planned_event_id=nullif(trim(p_planned_event_id),'') and generation=p_generation
      and state='reconcile_current';
  return found;
end; $$;

revoke execute on function public.settle_prospect_tour_google_calendar_current_reconciliation(text,uuid,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.settle_prospect_tour_google_calendar_current_reconciliation(text,uuid,timestamptz,timestamptz) to service_role;
