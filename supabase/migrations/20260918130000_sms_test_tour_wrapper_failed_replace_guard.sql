-- The authenticated SMS-test wrapper installed by 20260917201500 stamps an
-- existing event before invoking the lifecycle core so cancel/delete cleanup
-- observes the marker atomically. A replace already carries the marker in its
-- replacement event; pre-stamping it would incorrectly retain test provenance
-- if the CAS core rejects a stale/conflicting replacement. Limit the pre-write
-- to the two operations that remove or carry forward the old JSON object.

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
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event jsonb := coalesce(p_event,'{}'::jsonb);
  v_existing jsonb;
  v_provenance jsonb;
  v_event_id text := nullif(trim(v_event->>'id'),'');
begin
  if p_operation not in ('append','append_event','cancel','delete','replace','patch') or v_event_id is null then
    raise exception 'invalid tour schedule mutation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('proplane:confirmed-tour-schedule',0));
  select value into v_existing
    from public.portal_schedule_records r,
      jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value
    where r.id='axis_admin_planned_events_v1' and value->>'id'=v_event_id
    for update;

  v_provenance := case
    when jsonb_typeof(v_event->'smsTestProvenance')='object'
      and coalesce(trim(v_event->'smsTestProvenance'->>'actorUserId'),'')<>''
      and coalesce(trim(v_event->'smsTestProvenance'->>'managerUserId'),'')<>''
      and coalesce(trim(v_event->'smsTestProvenance'->>'sessionId'),'')<>''
      then v_event->'smsTestProvenance'
    when jsonb_typeof(v_existing->'smsTestProvenance')='object'
      and coalesce(trim(v_existing->'smsTestProvenance'->>'actorUserId'),'')<>''
      and coalesce(trim(v_existing->'smsTestProvenance'->>'managerUserId'),'')<>''
      and coalesce(trim(v_existing->'smsTestProvenance'->>'sessionId'),'')<>''
      then v_existing->'smsTestProvenance'
    else null
  end;
  if v_provenance is not null then
    v_event := v_event || jsonb_build_object(
      'smsTestProvenance',v_provenance,'smsTestSessionId',v_provenance->>'sessionId'
    );
    if p_operation in ('cancel','delete')
      and v_existing is not null
      and v_existing->'smsTestProvenance' is distinct from v_provenance then
      update public.portal_schedule_records r set
        row_data=r.row_data || jsonb_build_object('payload',(
          select coalesce(jsonb_agg(case when value->>'id'=v_event_id then
            value || jsonb_build_object('smsTestProvenance',v_provenance,'smsTestSessionId',v_provenance->>'sessionId')
            else value end),'[]'::jsonb)
          from jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value
        )),updated_at=now()
      where r.id='axis_admin_planned_events_v1';
    end if;
  end if;
  return public.mutate_confirmed_tour_schedule_core(
    p_operation,v_event,p_remove_inquiry_ids,p_allow_conflict,
    p_expected_start,p_expected_end,p_expected_generation,p_expected_generation_known
  );
end;
$$;

revoke execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) from public,anon,authenticated;
grant execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) to service_role;
