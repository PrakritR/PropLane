-- Forward correction for the already-applied test-workspace schedule wrapper.
-- Reject SQL NULL/non-array snapshots and require every client-supplied event
-- to carry the authenticated manager owner. Preserve existing rows with a
-- missing/different owner instead of allowing NULL comparison to erase them.
create or replace function public.replace_manager_planned_schedule_slice_namespace(
  p_workspace_id uuid,
  p_manager_user_id uuid,
  p_events jsonb,
  p_expected_events jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_row jsonb := '{}'::jsonb; v_events jsonb := '[]'::jsonb;
  v_next jsonb := '[]'::jsonb; v_data jsonb;
begin
  if p_manager_user_id is null
    or jsonb_typeof(p_events) is distinct from 'array'
    or jsonb_typeof(p_expected_events) is distinct from 'array'
  then
    return jsonb_build_object('ok',false,'reason','invalid_payload');
  end if;
  if public.test_workspace_for_user(p_manager_user_id) is distinct from p_workspace_id then
    return jsonb_build_object('ok',false,'reason','workspace_mismatch');
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_events) value
    where nullif(trim(value->>'id'),'') is null
      or (value->>'managerUserId') is distinct from p_manager_user_id::text
  ) or exists(
    select 1 from jsonb_array_elements(p_expected_events) value
    where nullif(trim(value->>'id'),'') is null
      or (value->>'managerUserId') is distinct from p_manager_user_id::text
  ) then
    return jsonb_build_object('ok',false,'reason','invalid_owned_event');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(case when p_workspace_id is null
    then 'proplane:confirmed-tour-schedule'
    else 'proplane:confirmed-tour-schedule:'||p_workspace_id::text end,0));
  if p_workspace_id is null then
    select row_data into v_row from public.portal_schedule_records where id='axis_admin_planned_events_v1' for update;
  else
    select row_data into v_row from public.test_workspace_schedule_records where workspace_id=p_workspace_id and record_key='planned_events' for update;
  end if;
  v_events := coalesce(v_row->'payload','[]'::jsonb);
  if jsonb_typeof(v_events) is distinct from 'array' then v_events := '[]'::jsonb; end if;
  if (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb) from jsonb_array_elements(v_events) value where value->>'managerUserId'=p_manager_user_id::text)
    <> (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb) from jsonb_array_elements(p_expected_events) value) then
    return jsonb_build_object('ok',false,'reason','stale_schedule');
  end if;
  select coalesce(jsonb_agg(value),'[]'::jsonb) into v_next
  from jsonb_array_elements(v_events) value
  where (value->>'managerUserId') is distinct from p_manager_user_id::text;
  v_next := v_next||p_events;
  v_data := coalesce(v_row,'{}'::jsonb)||jsonb_build_object('id','axis_admin_planned_events_v1','recordType','axis_admin_planned_events_v1','managerUserId',null,'propertyId',null,'payload',v_next);
  if p_workspace_id is null then
    insert into public.portal_schedule_records(id,manager_user_id,property_id,record_type,row_data,updated_at)
      values('axis_admin_planned_events_v1',null,null,'axis_admin_planned_events_v1',v_data,now())
      on conflict(id) do update set row_data=excluded.row_data,updated_at=now();
  else
    insert into public.test_workspace_schedule_records(workspace_id,record_key,row_data,updated_at)
      values(p_workspace_id,'planned_events',v_data,now())
      on conflict(workspace_id,record_key) do update set row_data=excluded.row_data,updated_at=now();
  end if;
  return jsonb_build_object('ok',true);
end;
$$;

revoke execute on function public.replace_manager_planned_schedule_slice_namespace(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.replace_manager_planned_schedule_slice_namespace(uuid,uuid,jsonb,jsonb) to service_role;
