-- A Google insert is an external side effect. Record its intent before the
-- request starts, and do not allow cleanup to become terminal while an insert
-- can still commit. The provider request is bounded below its 120-second
-- deadline; expired intents are reconciled by the recovery worker.

create table if not exists public.prospect_tour_google_calendar_create_intents (
  planned_event_id text primary key,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  google_calendar_event_id text not null,
  generation uuid not null default gen_random_uuid(),
  expected_start timestamptz not null,
  expected_end timestamptz not null,
  state text not null default 'creating' check (state in ('creating','cleanup_required','reconcile_current','reconciling','settled','reconciled','tombstone')),
  lease_owner text,
  lease_expires_at timestamptz,
  provider_deadline_at timestamptz not null,
  last_error text,
  reconciliation_attempts integer not null default 0,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prospect_tour_google_create_intents_recovery_idx
  on public.prospect_tour_google_calendar_create_intents(provider_deadline_at, updated_at)
  where state in ('creating','cleanup_required','reconcile_current','reconciling','tombstone');

create or replace function public.begin_prospect_tour_google_calendar_create(
  p_manager_user_id uuid,
  p_planned_event_id text,
  p_expected_start timestamptz,
  p_expected_end timestamptz,
  p_worker_id text,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event jsonb;
  v_intent public.prospect_tour_google_calendar_create_intents;
  v_id text := nullif(trim(p_planned_event_id), '');
  v_remote_id text;
  v_generation uuid := gen_random_uuid();
  v_lease_seconds integer := greatest(120, least(p_lease_seconds, 300));
begin
  if p_manager_user_id is null or v_id is null or p_expected_start is null or p_expected_end is null
    or coalesce(trim(p_worker_id), '') = '' then
    raise exception 'invalid prospect tour Google create intent';
  end if;
  select value into v_event
    from public.portal_schedule_records r,
      lateral jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value
    where r.id = 'axis_admin_planned_events_v1' and value->>'id' = v_id
    for update;
  if v_event is null or coalesce(v_event->>'canceledAt','') <> ''
    or (v_event->>'start')::timestamptz is distinct from p_expected_start
    or (v_event->>'end')::timestamptz is distinct from p_expected_end then
    return jsonb_build_object('allowed', false, 'reason', 'stale');
  end if;
  select * into v_intent from public.prospect_tour_google_calendar_create_intents
    where planned_event_id = v_id for update;
  if found and v_intent.state in ('creating','cleanup_required','reconcile_current','reconciling')
    and v_intent.provider_deadline_at > now() then
    return jsonb_build_object('allowed', false, 'reason', 'in_flight');
  end if;
  v_remote_id := encode(pg_catalog.sha256(pg_catalog.convert_to(p_manager_user_id::text || ':' || v_id, 'UTF8')), 'hex');
  insert into public.prospect_tour_google_calendar_create_intents(
    planned_event_id, manager_user_id, google_calendar_event_id, generation,
    expected_start, expected_end, state, lease_owner, lease_expires_at,
    provider_deadline_at, last_error, settled_at, updated_at
  ) values (
    v_id, p_manager_user_id, v_remote_id, v_generation,
    p_expected_start, p_expected_end, 'creating', p_worker_id,
    now() + make_interval(secs => v_lease_seconds),
    now() + make_interval(secs => v_lease_seconds), null, null, now()
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
  -- Match begin/trigger lock order: schedule row first, then intent. Reversing
  -- these locks deadlocks a cancellation racing create settlement.
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
  -- The provider call returned, so this generation cannot commit later. The
  -- cleanup row remains pending until its deterministic delete is observed.
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

create or replace function public.claim_prospect_tour_google_calendar_create_reconciliation(
  p_worker_id text,
  p_lease_seconds integer default 120
) returns table(planned_event_id text, manager_user_id uuid, google_calendar_event_id text, generation uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.prospect_tour_google_calendar_create_intents;
begin
  select * into v_row from public.prospect_tour_google_calendar_create_intents i
    where (i.state in ('creating','cleanup_required','reconcile_current','tombstone')
        or (i.state='reconciling' and i.lease_expires_at<=now()))
      and i.provider_deadline_at <= now()
    order by i.updated_at asc for update skip locked limit 1;
  if not found then return; end if;
  update public.prospect_tour_google_calendar_create_intents i set
    state='reconciling', lease_owner=p_worker_id,
    lease_expires_at=now()+make_interval(secs=>greatest(120,least(p_lease_seconds,300))),
    reconciliation_attempts=reconciliation_attempts+1, updated_at=now()
    where i.planned_event_id=v_row.planned_event_id;
  return query select v_row.planned_event_id,v_row.manager_user_id,v_row.google_calendar_event_id,v_row.generation;
end; $$;

create or replace function public.complete_prospect_tour_google_calendar_create_reconciliation(
  p_planned_event_id text,
  p_generation uuid,
  p_worker_id text,
  p_state text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_state not in ('settled','reconciled') then raise exception 'invalid Google create reconciliation state'; end if;
  update public.prospect_tour_google_calendar_create_intents set
    -- A 404 after the original request's lease expires is not proof that the
    -- request can never commit. Keep a durable, periodically reclaimed
    -- tombstone for canceled tours so a delayed deterministic insert is
    -- deleted on a later sweep. Live events can settle normally.
    state=case when p_state='reconciled' then 'tombstone' else p_state end,
    lease_owner=null, lease_expires_at=null, last_error=null,
    provider_deadline_at=case when p_state='reconciled' then now()+make_interval(
      secs => least(86400, (120 * power(2, least(greatest(reconciliation_attempts - 1, 0), 10)))::integer)
    ) else provider_deadline_at end,
    settled_at=now(), updated_at=now()
    where planned_event_id=nullif(trim(p_planned_event_id),'') and generation=p_generation
      and state='reconciling' and lease_owner=p_worker_id;
  return found;
end; $$;

-- A create cancellation is recorded in the same schedule transaction. A
-- reschedule stays recoverable as the current event, never as deletion work.
create or replace function public.guard_prospect_tour_google_calendar_create_intents()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_intent public.prospect_tour_google_calendar_create_intents; v_prior jsonb; v_replacement jsonb;
begin
  if new.id <> 'axis_admin_planned_events_v1' then return new; end if;
  for v_intent in select * from public.prospect_tour_google_calendar_create_intents
    where state in ('creating','cleanup_required','reconcile_current','reconciling') loop
    v_prior := null;
    v_replacement := null;
    select value into v_prior from jsonb_array_elements(coalesce(old.row_data->'payload','[]'::jsonb)) value
      where value->>'id'=v_intent.planned_event_id;
    select value into v_replacement from jsonb_array_elements(coalesce(new.row_data->'payload','[]'::jsonb)) value
      where value->>'id'=v_intent.planned_event_id;
    -- Invalidate only a lifecycle/window transition made by this schedule
    -- update. Metadata-only writes (notably persisting the recovered Google
    -- id) must not invalidate the reconciliation lease they are completing.
    if v_prior is not null and (v_replacement is null
      or (coalesce(v_prior->>'canceledAt','')='' and coalesce(v_replacement->>'canceledAt','')<>'')) then
      update public.prospect_tour_google_calendar_create_intents set state='cleanup_required',updated_at=now()
        where planned_event_id=v_intent.planned_event_id;
      perform public.enqueue_prospect_tour_google_calendar_cleanup(v_intent.manager_user_id,v_intent.planned_event_id,v_intent.google_calendar_event_id);
    elsif v_prior is not null and v_replacement is not null and (
      (v_replacement->>'start')::timestamptz is distinct from (v_prior->>'start')::timestamptz
      or (v_replacement->>'end')::timestamptz is distinct from (v_prior->>'end')::timestamptz
    ) then
      update public.prospect_tour_google_calendar_create_intents set state='reconcile_current',updated_at=now()
        where planned_event_id=v_intent.planned_event_id;
    end if;
  end loop;
  return new;
end; $$;
drop trigger if exists guard_prospect_tour_google_calendar_create_intents on public.portal_schedule_records;
create trigger guard_prospect_tour_google_calendar_create_intents
after update of row_data on public.portal_schedule_records
for each row execute function public.guard_prospect_tour_google_calendar_create_intents();

-- A cleanup delete returning 404 is not terminal until all potentially
-- in-flight creates have been reconciled after their provider deadline.
create or replace function public.complete_prospect_tour_google_calendar_cleanup(
  p_planned_event_id text,
  p_worker_id text default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from public.prospect_tour_google_calendar_create_intents i
    where i.planned_event_id=nullif(trim(p_planned_event_id),'')
      and i.state in ('creating','cleanup_required','reconcile_current','reconciling')
  ) then return false; end if;
  update public.prospect_tour_google_calendar_cleanup set
    status='completed',last_error=null,lease_owner=null,lease_expires_at=null,completed_at=now(),updated_at=now()
    where planned_event_id=nullif(trim(p_planned_event_id),'')
      and status in ('pending','running')
      and (p_worker_id is null or lease_owner=p_worker_id);
  return found;
end; $$;

create or replace function public.claim_prospect_tour_google_calendar_cleanup(
  p_worker_id text,
  p_lease_seconds integer default 120
) returns table(planned_event_id text, manager_user_id uuid, google_calendar_event_id text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.prospect_tour_google_calendar_cleanup;
begin
  select c.* into v_row from public.prospect_tour_google_calendar_cleanup c
    where (c.status='pending' or (c.status='running' and c.lease_expires_at<=now()))
      and not exists (
        select 1 from public.prospect_tour_google_calendar_create_intents i
        where i.planned_event_id=c.planned_event_id
          and i.state in ('creating','cleanup_required','reconcile_current','reconciling')
      )
    order by c.updated_at asc for update skip locked limit 1;
  if not found then return; end if;
  update public.prospect_tour_google_calendar_cleanup c set status='running',attempts=c.attempts+1,
    lease_owner=p_worker_id,lease_expires_at=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,300))),updated_at=now()
    where c.planned_event_id=v_row.planned_event_id;
  return query select v_row.planned_event_id,v_row.manager_user_id,v_row.google_calendar_event_id;
end; $$;

alter table public.prospect_tour_google_calendar_create_intents enable row level security;
revoke all on table public.prospect_tour_google_calendar_create_intents from anon, authenticated;
grant select, insert, update, delete on table public.prospect_tour_google_calendar_create_intents to service_role;
revoke execute on function public.begin_prospect_tour_google_calendar_create(uuid,text,timestamptz,timestamptz,text,integer) from public, anon, authenticated;
revoke execute on function public.settle_prospect_tour_google_calendar_create(text,uuid,text,text) from public, anon, authenticated;
revoke execute on function public.claim_prospect_tour_google_calendar_create_reconciliation(text,integer) from public, anon, authenticated;
revoke execute on function public.complete_prospect_tour_google_calendar_create_reconciliation(text,uuid,text,text) from public, anon, authenticated;
revoke execute on function public.complete_prospect_tour_google_calendar_cleanup(text,text) from public, anon, authenticated;
grant execute on function public.begin_prospect_tour_google_calendar_create(uuid,text,timestamptz,timestamptz,text,integer) to service_role;
grant execute on function public.settle_prospect_tour_google_calendar_create(text,uuid,text,text) to service_role;
grant execute on function public.claim_prospect_tour_google_calendar_create_reconciliation(text,integer) to service_role;
grant execute on function public.complete_prospect_tour_google_calendar_create_reconciliation(text,uuid,text,text) to service_role;
grant execute on function public.complete_prospect_tour_google_calendar_cleanup(text,text) to service_role;
