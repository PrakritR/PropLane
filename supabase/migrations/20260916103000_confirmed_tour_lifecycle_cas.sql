-- The September 15 confirmed-tour RPC has already been applied. Retire its
-- unsafe four-argument entry point. Calls with fewer arguments resolve to the
-- defaulted signature below, while replacements must supply its CAS fields.

drop function if exists public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean);

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
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_planned jsonb := '[]'::jsonb;
  v_inquiries jsonb := '[]'::jsonb;
  v_next jsonb;
  v_current jsonb;
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

  -- This is the existing singleton writer lock. The manager-keyed lock makes
  -- the reservation interval check and insert one serializable critical
  -- section even when the JSON mirror is absent.
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select coalesce(row_data->'payload','[]'::jsonb) into v_planned
    from public.portal_schedule_records where id = 'axis_admin_planned_events_v1' for update;
  if not found then v_planned := '[]'::jsonb; end if;
  select coalesce(row_data->'payload','[]'::jsonb) into v_inquiries
    from public.portal_schedule_records where id = 'axis_admin_partner_inquiries_v1' for update;
  if not found then v_inquiries := '[]'::jsonb; end if;

  -- Generic events may use append_event/patch, but a tour can never enter or
  -- mutate through either bypass. Its lifecycle has to use append/cancel/
  -- delete or the CAS-protected replace branch below.
  if p_operation = 'append_event' and coalesce(p_event->>'kind','') = 'tour' then
    return jsonb_build_object('ok',false,'reason','tour_lifecycle_required');
  end if;
  if p_operation = 'patch' and (
    coalesce(p_event->>'kind','') = 'tour'
    or exists (select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id and coalesce(e->>'kind','')='tour')
  ) then
    return jsonb_build_object('ok',false,'reason','tour_lifecycle_required');
  end if;

  if p_operation = 'append' then
    v_manager := nullif(p_event->>'managerUserId','')::uuid;
    v_slot_key := nullif(p_event->>'slotKey','');
    v_start := nullif(p_event->>'start','')::timestamptz;
    v_end := nullif(p_event->>'end','')::timestamptz;
    if v_manager is null or v_slot_key is null or v_start is null or v_end is null or v_end <= v_start then
      raise exception 'invalid tour event';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('proplane:tour-slot-reservation:' || v_manager::text, 0));
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
    if not p_allow_conflict and exists (
      select 1 from public.tour_slot_reservations r
      where r.manager_user_id = v_manager and r.status = 'active'
        and r.planned_event_id <> v_event_id
        and (r.slot_key = v_slot_key or (r.starts_at < v_end and v_start < r.ends_at))
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
    perform pg_advisory_xact_lock(hashtextextended('proplane:tour-slot-reservation:' || v_manager::text, 0));
    select e into v_current from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id limit 1;
    if v_current is null then return jsonb_build_object('ok',false,'reason','not_found'); end if;
    if coalesce(v_current->>'canceledAt','') <> '' then return jsonb_build_object('ok',false,'reason','stale_event'); end if;
    if p_expected_start is null or p_expected_end is null or not p_expected_generation_known then
      return jsonb_build_object('ok',false,'reason','expected_window_required');
    end if;
    if nullif(v_current->>'managerUserId','')::uuid is distinct from v_manager then
      return jsonb_build_object('ok',false,'reason','ownership_conflict');
    end if;
    if nullif(v_current->>'start','')::timestamptz is distinct from p_expected_start
      or nullif(v_current->>'end','')::timestamptz is distinct from p_expected_end then
      return jsonb_build_object('ok',false,'reason','stale_event');
    end if;
    if nullif(v_current->>'rescheduleNotificationGeneration','') is distinct from nullif(p_expected_generation,'') then
      return jsonb_build_object('ok',false,'reason','stale_event');
    end if;
    -- Conflict override is an append-only confirmation contract. A replacement
    -- always checks both authorities before retiring its current reservation.
    if exists (
      select 1 from jsonb_array_elements(v_planned) e
      where e->>'id' <> v_event_id and e->>'kind'='tour' and coalesce(e->>'canceledAt','')=''
        and e->>'managerUserId'=v_manager::text
        and (coalesce(e->>'slotKey','')=v_slot_key or (nullif(e->>'start','')::timestamptz < v_end and v_start < nullif(e->>'end','')::timestamptz))
    ) then return jsonb_build_object('ok',false,'reason','conflict'); end if;
    if exists (
      select 1 from public.tour_slot_reservations r
      where r.manager_user_id = v_manager and r.status = 'active'
        and r.planned_event_id <> v_event_id
        and (r.slot_key = v_slot_key or (r.starts_at < v_end and v_start < r.ends_at))
    ) then return jsonb_build_object('ok',false,'reason','conflict'); end if;
    update public.tour_slot_reservations set status='rescheduled',updated_at=now()
      where planned_event_id=v_event_id and status='active';
    insert into public.tour_slot_reservations(manager_user_id,property_id,slot_key,starts_at,ends_at,planned_event_id,status)
    values(v_manager,nullif(p_event->>'propertyId',''),v_slot_key,v_start,v_end,v_event_id,'active')
    on conflict(manager_user_id,slot_key) do update set
      property_id=excluded.property_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
      planned_event_id=excluded.planned_event_id,status='active',updated_at=now()
    where public.tour_slot_reservations.status in ('cancelled','rescheduled')
      or public.tour_slot_reservations.planned_event_id=excluded.planned_event_id;
    if not found then return jsonb_build_object('ok',false,'reason','conflict'); end if;
    v_next := (select coalesce(jsonb_agg(case when e->>'id'=v_event_id then p_event else e end),'[]'::jsonb) from jsonb_array_elements(v_planned) e);
  elsif p_operation = 'delete' then
    v_exists := exists(select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id);
    if not v_exists then return jsonb_build_object('ok',false,'reason','not_found'); end if;
    v_next := (select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(v_planned) e where e->>'id'<>v_event_id);
    update public.tour_slot_reservations set status='cancelled',updated_at=now() where planned_event_id=v_event_id and status='active';
    update public.prospect_tour_bookings set status='cancelled',updated_at=now() where planned_event_id=v_event_id and status in ('confirmed','rescheduled');
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

revoke execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) from public, anon, authenticated;
grant execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) to service_role;
