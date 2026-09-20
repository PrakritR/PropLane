-- Generic calendar events share the legacy planned-events JSON read model with
-- tours. Keep their append/cancel and manager-slice replacement under one
-- advisory lock so they cannot overwrite concurrent tour mutations.

create or replace function public.mutate_planned_schedule_event(
  p_operation text,
  p_event jsonb,
  p_expected_start timestamptz default null,
  p_expected_end timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row jsonb := '{}'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_next jsonb := '[]'::jsonb;
  v_data jsonb;
  v_id text := nullif(trim(p_event->>'id'), '');
  v_current jsonb;
begin
  if p_operation not in ('append', 'cancel', 'replace') or v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_event');
  end if;
  if p_operation in ('append', 'replace')
    and (nullif(trim(p_event->>'managerUserId'), '') is null
      or nullif(trim(p_event->>'start'), '') is null
      or nullif(trim(p_event->>'end'), '') is null) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_event');
  end if;

  -- The tour RPC uses this same stable lock key, so generic calendar activity
  -- and confirmed-tour activity serialize even if the singleton row is absent.
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select row_data into v_row from public.portal_schedule_records
    where id='axis_admin_planned_events_v1' for update;
  v_events := coalesce(v_row->'payload', '[]'::jsonb);
  if jsonb_typeof(v_events) <> 'array' then v_events := '[]'::jsonb; end if;
  select value into v_current from jsonb_array_elements(v_events)
    where value->>'id'=v_id limit 1;

  if p_operation='append' then
    if v_current is not null then
      if v_current->>'managerUserId'=p_event->>'managerUserId'
        and v_current->>'start'=p_event->>'start' and v_current->>'end'=p_event->>'end' then
        return jsonb_build_object('ok', true, 'idempotent', true, 'event', v_current);
      end if;
      return jsonb_build_object('ok', false, 'reason', 'event_id_conflict');
    end if;
    v_next := v_events || jsonb_build_array(p_event);
  else
    if v_current is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if nullif(trim(p_event->>'managerUserId'), '') is not null
      and v_current->>'managerUserId'<>p_event->>'managerUserId' then
      return jsonb_build_object('ok', false, 'reason', 'ownership_conflict');
    end if;
    if (p_expected_start is not null and (v_current->>'start')::timestamptz<>p_expected_start)
      or (p_expected_end is not null and (v_current->>'end')::timestamptz<>p_expected_end) then
      return jsonb_build_object('ok', false, 'reason', 'stale_event');
    end if;
    select coalesce(jsonb_agg(case when value->>'id'=v_id and p_operation='replace' then p_event else value end), '[]'::jsonb)
      into v_next from jsonb_array_elements(v_events);
    if p_operation='cancel' then
      select coalesce(jsonb_agg(value), '[]'::jsonb) into v_next
        from jsonb_array_elements(v_events) where value->>'id'<>v_id;
    end if;
  end if;

  v_data := (coalesce(v_row, '{}'::jsonb) || jsonb_build_object(
    'id', 'axis_admin_planned_events_v1', 'recordType', 'axis_admin_planned_events_v1',
    'managerUserId', null, 'propertyId', null, 'payload', v_next
  ));
  insert into public.portal_schedule_records(
    id, manager_user_id, property_id, record_type, starts_at, ends_at, row_data, updated_at
  ) values (
    'axis_admin_planned_events_v1', null, null, 'axis_admin_planned_events_v1',
    nullif(p_event->>'start','')::timestamptz, nullif(p_event->>'end','')::timestamptz, v_data, now()
  ) on conflict (id) do update set
    row_data=excluded.row_data, updated_at=now(),
    starts_at=case when p_operation='append' then excluded.starts_at else public.portal_schedule_records.starts_at end,
    ends_at=case when p_operation='append' then excluded.ends_at else public.portal_schedule_records.ends_at end;
  return jsonb_build_object('ok', true, 'idempotent', false, 'event', p_event);
end; $$;

create or replace function public.replace_manager_planned_schedule_slice(
  p_manager_user_id uuid,
  p_events jsonb,
  p_expected_events jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row jsonb := '{}'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_next jsonb := '[]'::jsonb;
  v_data jsonb;
begin
  if p_manager_user_id is null or jsonb_typeof(p_events)<>'array' or jsonb_typeof(p_expected_events)<>'array' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_events) value
    where nullif(trim(value->>'id'),'') is null
      or value->>'managerUserId'<>p_manager_user_id::text
  ) then return jsonb_build_object('ok', false, 'reason', 'invalid_owned_event'); end if;

  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select row_data into v_row from public.portal_schedule_records
    where id='axis_admin_planned_events_v1' for update;
  v_events := coalesce(v_row->'payload', '[]'::jsonb);
  if jsonb_typeof(v_events)<>'array' then v_events := '[]'::jsonb; end if;
  if (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb) from jsonb_array_elements(v_events) value where value->>'managerUserId'=p_manager_user_id::text)
    <> (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb) from jsonb_array_elements(p_expected_events) value) then
    return jsonb_build_object('ok',false,'reason','stale_schedule');
  end if;
  select coalesce(jsonb_agg(value), '[]'::jsonb) into v_next
    from jsonb_array_elements(v_events) where value->>'managerUserId'<>p_manager_user_id::text;
  v_next := v_next || p_events;
  v_data := coalesce(v_row, '{}'::jsonb) || jsonb_build_object(
    'id', 'axis_admin_planned_events_v1', 'recordType', 'axis_admin_planned_events_v1',
    'managerUserId', null, 'propertyId', null, 'payload', v_next
  );
  insert into public.portal_schedule_records(id, manager_user_id, property_id, record_type, row_data, updated_at)
    values ('axis_admin_planned_events_v1', null, null, 'axis_admin_planned_events_v1', v_data, now())
  on conflict (id) do update set row_data=excluded.row_data, updated_at=now();
  return jsonb_build_object('ok', true);
end; $$;

revoke execute on function public.mutate_planned_schedule_event(text,jsonb,timestamptz,timestamptz) from public, anon, authenticated;
revoke execute on function public.replace_manager_planned_schedule_slice(uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.mutate_planned_schedule_event(text,jsonb,timestamptz,timestamptz) to service_role;
grant execute on function public.replace_manager_planned_schedule_slice(uuid,jsonb,jsonb) to service_role;
