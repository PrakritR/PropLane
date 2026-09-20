-- A shared-calendar snapshot may mutate only the caller's non-tour slice, and
-- only from a baseline the browser actually observed. Tours remain owned by
-- their dedicated lifecycle RPCs. Admins may CAS-edit any non-tour event while
-- preserving its explicit null/manager ownership.

create or replace function public.replace_manager_planned_schedule_slice(
  p_manager_user_id uuid,
  p_events jsonb,
  p_expected_events jsonb,
  p_actor_is_admin boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row jsonb := '{}'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_next jsonb := '[]'::jsonb;
  v_data jsonb;
begin
  if p_manager_user_id is null
    or p_events is null or jsonb_typeof(p_events)<>'array'
    or p_expected_events is null or jsonb_typeof(p_expected_events)<>'array' then
    return jsonb_build_object('ok', false, 'reason', 'stale_schedule');
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_events) value
    where nullif(trim(value->>'id'),'') is null
      or coalesce(value->>'kind','')='tour'
      or (not coalesce(p_actor_is_admin,false)
        and (value->>'managerUserId') is distinct from p_manager_user_id::text)
  ) or exists (
    select 1 from jsonb_array_elements(p_expected_events) value
    where nullif(trim(value->>'id'),'') is null
      or coalesce(value->>'kind','')='tour'
      or (not coalesce(p_actor_is_admin,false)
        and (value->>'managerUserId') is distinct from p_manager_user_id::text)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_owned_event');
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_events) value
    group by value->>'id' having count(*)>1
  ) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate_event_id');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule', 0));
  select row_data into v_row from public.portal_schedule_records
    where id='axis_admin_planned_events_v1' for update;
  v_events := coalesce(v_row->'payload', '[]'::jsonb);
  if jsonb_typeof(v_events)<>'array' then v_events := '[]'::jsonb; end if;

  -- Reject an attempted same-id takeover of a protected row. The route filters
  -- known protected rows too, but only this check sees a row added after its
  -- pre-RPC read.
  if exists (
    select 1
    from jsonb_array_elements(p_events) incoming
    join jsonb_array_elements(v_events) current
      on current->>'id'=incoming->>'id'
    where coalesce(current->>'kind','')='tour'
      or (not coalesce(p_actor_is_admin,false)
        and (current->>'managerUserId') is distinct from p_manager_user_id::text)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'event_id_conflict');
  end if;

  if coalesce(p_actor_is_admin,false) then
    if (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb)
        from jsonb_array_elements(v_events) value
        where coalesce(value->>'kind','')<>'tour')
      <> (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb)
          from jsonb_array_elements(p_expected_events) value) then
      return jsonb_build_object('ok',false,'reason','stale_schedule');
    end if;
    select coalesce(jsonb_agg(value), '[]'::jsonb) into v_next
      from jsonb_array_elements(v_events) value
      where coalesce(value->>'kind','')='tour';
  else
    if (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb)
        from jsonb_array_elements(v_events) value
        where value->>'managerUserId'=p_manager_user_id::text
          and coalesce(value->>'kind','')<>'tour')
      <> (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb)
          from jsonb_array_elements(p_expected_events) value) then
      return jsonb_build_object('ok',false,'reason','stale_schedule');
    end if;
    select coalesce(jsonb_agg(value), '[]'::jsonb) into v_next
      from jsonb_array_elements(v_events) value
      where coalesce(value->>'kind','')='tour'
        or (value->>'managerUserId') is distinct from p_manager_user_id::text;
  end if;

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

-- Retire the three-argument snapshot RPC once this correction is applied. It
-- cannot prove a browser-observed baseline and must not remain service-callable.
revoke execute on function public.replace_manager_planned_schedule_slice(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.replace_manager_planned_schedule_slice(uuid,jsonb,jsonb,boolean)
  from public, anon, authenticated;
grant execute on function public.replace_manager_planned_schedule_slice(uuid,jsonb,jsonb,boolean)
  to service_role;
