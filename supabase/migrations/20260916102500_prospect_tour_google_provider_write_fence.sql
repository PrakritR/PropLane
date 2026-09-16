-- A reconciliation lease is not itself a provider-write fence. The bounded
-- deadline delays successor claims while the ordinary provider request should
-- finish, but it cannot prevent an arbitrarily late PATCH. Actual write
-- ordering comes from Google's ETag/If-Match plus the post-GET durable
-- generation, owner, and window validation defined below.

create or replace function public.begin_prospect_tour_google_calendar_write(
  p_manager_user_id uuid,
  p_planned_event_id text,
  p_google_calendar_event_id text,
  p_expected_start timestamptz,
  p_expected_end timestamptz,
  p_worker_id text,
  p_provider_seconds integer default 120
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event jsonb;
  v_intent public.prospect_tour_google_calendar_create_intents;
  v_id text := nullif(trim(p_planned_event_id), '');
  v_remote_id text;
  v_generation uuid := gen_random_uuid();
  v_deadline timestamptz := now() + make_interval(secs => greatest(30, least(p_provider_seconds, 300)));
begin
  if p_manager_user_id is null or v_id is null or p_expected_start is null or p_expected_end is null
    or coalesce(trim(p_worker_id), '') = '' then
    raise exception 'invalid prospect tour Google write intent';
  end if;
  select value into v_event
    from public.portal_schedule_records r,
      lateral jsonb_array_elements(coalesce(r.row_data->'payload', '[]'::jsonb)) value
    where r.id = 'axis_admin_planned_events_v1' and value->>'id' = v_id
    for update;
  if v_event is null or coalesce(v_event->>'canceledAt', '') <> ''
    or (v_event->>'start')::timestamptz is distinct from p_expected_start
    or (v_event->>'end')::timestamptz is distinct from p_expected_end then
    return jsonb_build_object('allowed', false, 'reason', 'stale');
  end if;
  select * into v_intent from public.prospect_tour_google_calendar_create_intents
    where planned_event_id = v_id for update;
  if found and v_intent.state in ('creating', 'cleanup_required', 'reconcile_current', 'reconciling')
    and v_intent.provider_deadline_at > now() then
    return jsonb_build_object('allowed', false, 'reason', 'in_flight');
  end if;
  v_remote_id := coalesce(
    nullif(trim(p_google_calendar_event_id), ''),
    encode(pg_catalog.sha256(pg_catalog.convert_to(p_manager_user_id::text || ':' || v_id, 'UTF8')), 'hex')
  );
  insert into public.prospect_tour_google_calendar_create_intents(
    planned_event_id, manager_user_id, google_calendar_event_id, generation,
    expected_start, expected_end, state, lease_owner, lease_expires_at,
    provider_deadline_at, last_error, settled_at, updated_at
  ) values (
    v_id, p_manager_user_id, v_remote_id, v_generation,
    p_expected_start, p_expected_end, 'creating', p_worker_id, v_deadline,
    v_deadline, null, null, now()
  ) on conflict (planned_event_id) do update set
    manager_user_id = excluded.manager_user_id,
    google_calendar_event_id = excluded.google_calendar_event_id,
    generation = excluded.generation,
    expected_start = excluded.expected_start,
    expected_end = excluded.expected_end,
    state = 'creating',
    lease_owner = excluded.lease_owner,
    lease_expires_at = excluded.lease_expires_at,
    provider_deadline_at = excluded.provider_deadline_at,
    last_error = null,
    settled_at = null,
    updated_at = now();
  return jsonb_build_object('allowed', true, 'generation', v_generation, 'googleCalendarEventId', v_remote_id);
end; $$;

-- Google PATCH is guarded by the provider ETag, but the ETag is read before
-- this database check. This closes the slow-GET race: an expired worker cannot
-- read a successor's fresh ETag and then use it to write an old window.
create or replace function public.validate_prospect_tour_google_calendar_write(
  p_planned_event_id text,
  p_generation uuid,
  p_expected_start timestamptz,
  p_expected_end timestamptz,
  p_worker_id text default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event jsonb;
begin
  select value into v_event
    from public.portal_schedule_records r,
      lateral jsonb_array_elements(coalesce(r.row_data->'payload', '[]'::jsonb)) value
    where r.id = 'axis_admin_planned_events_v1'
      and value->>'id' = nullif(trim(p_planned_event_id), '')
    for update;
  if v_event is null or coalesce(v_event->>'canceledAt', '') <> ''
    or (v_event->>'start')::timestamptz is distinct from p_expected_start
    or (v_event->>'end')::timestamptz is distinct from p_expected_end then
    return false;
  end if;
  return exists (
    select 1 from public.prospect_tour_google_calendar_create_intents i
    where i.planned_event_id = nullif(trim(p_planned_event_id), '')
      and i.generation = p_generation
      and i.expected_start is not distinct from p_expected_start
      and i.expected_end is not distinct from p_expected_end
      and (
        (p_worker_id is null and i.state = 'creating')
        or (p_worker_id is not null and i.state = 'reconciling' and i.lease_owner = nullif(trim(p_worker_id), ''))
      )
  );
end; $$;

create or replace function public.begin_prospect_tour_google_calendar_reconciliation_write(
  p_planned_event_id text,
  p_generation uuid,
  p_worker_id text,
  p_expected_start timestamptz,
  p_expected_end timestamptz,
  p_provider_seconds integer default 120
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event jsonb;
  v_deadline timestamptz := now() + make_interval(secs => greatest(30, least(p_provider_seconds, 300)));
begin
  -- Keep the same lock order as begin/settle and the schedule trigger.
  select value into v_event
    from public.portal_schedule_records r,
      lateral jsonb_array_elements(coalesce(r.row_data->'payload', '[]'::jsonb)) value
    where r.id = 'axis_admin_planned_events_v1'
      and value->>'id' = nullif(trim(p_planned_event_id), '')
    for update;

  if v_event is null or coalesce(v_event->>'canceledAt', '') <> ''
    or (v_event->>'start')::timestamptz is distinct from p_expected_start
    or (v_event->>'end')::timestamptz is distinct from p_expected_end then
    return false;
  end if;

  update public.prospect_tour_google_calendar_create_intents set
    expected_start = p_expected_start,
    expected_end = p_expected_end,
    provider_deadline_at = v_deadline,
    lease_expires_at = greatest(coalesce(lease_expires_at, v_deadline), v_deadline),
    updated_at = now()
  where planned_event_id = nullif(trim(p_planned_event_id), '')
    and generation = p_generation
    and state = 'reconciling'
    and lease_owner = nullif(trim(p_worker_id), '');
  return found;
end; $$;

revoke execute on function public.begin_prospect_tour_google_calendar_reconciliation_write(text,uuid,text,timestamptz,timestamptz,integer)
  from public, anon, authenticated;
grant execute on function public.begin_prospect_tour_google_calendar_reconciliation_write(text,uuid,text,timestamptz,timestamptz,integer)
  to service_role;
revoke execute on function public.validate_prospect_tour_google_calendar_write(text,uuid,timestamptz,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.validate_prospect_tour_google_calendar_write(text,uuid,timestamptz,timestamptz,text)
  to service_role;
revoke execute on function public.begin_prospect_tour_google_calendar_write(uuid,text,text,timestamptz,timestamptz,text,integer)
  from public, anon, authenticated;
grant execute on function public.begin_prospect_tour_google_calendar_write(uuid,text,text,timestamptz,timestamptz,text,integer)
  to service_role;
