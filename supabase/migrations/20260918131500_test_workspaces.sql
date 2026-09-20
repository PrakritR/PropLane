-- Dedicated, operator-managed test-account classification. Membership state is
-- deliberately separate from classification: suspension never turns test data
-- into customer data.

create table if not exists public.test_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.test_workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.test_workspaces(id) on delete restrict,
  -- Intentionally no FK to auth.users: this durable classification must remain
  -- inspectable after a test account is removed from Auth.
  user_id uuid not null,
  portal_role text not null check (portal_role in ('manager', 'co_manager', 'resident')),
  state text not null default 'active' check (state in ('active', 'suspended')),
  expires_at timestamptz,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists test_workspace_members_workspace_idx
  on public.test_workspace_members (workspace_id, state, expires_at);

create or replace function public.prevent_test_workspace_membership_reclassification()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'test workspace classification is retained';
  end if;
  if old.user_id is distinct from new.user_id or old.workspace_id is distinct from new.workspace_id then
    raise exception 'test workspace classification is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists test_workspace_members_reclassification_guard on public.test_workspace_members;
create trigger test_workspace_members_reclassification_guard
  before update or delete on public.test_workspace_members
  for each row execute function public.prevent_test_workspace_membership_reclassification();

-- Durable provenance for sessions, messages, and management audit entries.
-- A non-null marker is immutable so later membership revocation cannot erase it.
alter table public.agent_sessions add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.agent_messages add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.audit_log add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.manager_property_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.manager_application_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.portal_work_order_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.portal_service_request_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.portal_household_charge_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.portal_schedule_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.portal_lease_pipeline_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.portal_pro_relationship_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.portal_scheduled_inbox_message_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.agent_pending_actions add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.prospect_sms_bursts add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.prospect_tour_scheduling_state add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.tour_slot_reservations add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.prospect_tour_bookings add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.portal_inbox_thread_records add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.account_link_invites add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
alter table public.vendor_invites add column if not exists test_workspace_id uuid references public.test_workspaces(id) on delete restrict;
create index if not exists agent_sessions_test_workspace_idx on public.agent_sessions (test_workspace_id, updated_at desc) where test_workspace_id is not null;
create index if not exists agent_messages_test_workspace_idx on public.agent_messages (test_workspace_id, created_at desc) where test_workspace_id is not null;
create index if not exists audit_log_test_workspace_idx on public.audit_log (test_workspace_id, created_at desc) where test_workspace_id is not null;
create index if not exists manager_property_records_test_workspace_idx on public.manager_property_records(test_workspace_id) where test_workspace_id is not null;
create index if not exists manager_application_records_test_workspace_idx on public.manager_application_records(test_workspace_id) where test_workspace_id is not null;
create index if not exists portal_work_order_records_test_workspace_idx on public.portal_work_order_records(test_workspace_id) where test_workspace_id is not null;
create index if not exists portal_service_request_records_test_workspace_idx on public.portal_service_request_records(test_workspace_id) where test_workspace_id is not null;
create index if not exists portal_schedule_records_test_workspace_idx on public.portal_schedule_records(test_workspace_id,record_type) where test_workspace_id is not null;
create index if not exists agent_pending_actions_test_workspace_idx on public.agent_pending_actions(test_workspace_id,status,created_at desc) where test_workspace_id is not null;

-- Workspace tours never share either legacy deployment-wide JSON singleton.
-- The shared mutation core below selects this storage namespace at its boundary.
create table if not exists public.test_workspace_schedule_records (
  workspace_id uuid not null references public.test_workspaces(id) on delete restrict,
  record_key text not null check (record_key in ('planned_events','partner_inquiries')),
  row_data jsonb not null default '{"payload":[]}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, record_key)
);
alter table public.test_workspace_schedule_records enable row level security;
revoke all on table public.test_workspace_schedule_records from public, anon, authenticated;
grant select, insert, update, delete on table public.test_workspace_schedule_records to service_role;

create or replace function public.test_workspace_for_user(p_user_id uuid)
returns uuid language sql stable security definer set search_path=public,pg_temp as $$
  select workspace_id from public.test_workspace_members where user_id=p_user_id;
$$;
revoke all on function public.test_workspace_for_user(uuid) from public,anon,authenticated;
grant execute on function public.test_workspace_for_user(uuid) to service_role;

create or replace function public.test_workspace_for_email(p_email text)
returns uuid language sql stable security definer set search_path=public,pg_temp as $$
  select m.workspace_id
  from public.profiles p join public.test_workspace_members m on m.user_id=p.id
  where lower(p.email)=lower(trim(p_email)) limit 1;
$$;
revoke all on function public.test_workspace_for_email(text) from public,anon,authenticated;
grant execute on function public.test_workspace_for_email(text) to service_role;

-- Derive provenance at every root insert/update. A client or service caller can
-- neither invent a workspace id nor join a classified principal to a normal or
-- foreign principal. Classification is resolved regardless of feature state.
create or replace function public.derive_test_workspace_provenance()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_json jsonb := to_jsonb(new);
  v_property_id text := nullif(v_json->>'property_id','');
  v_assigned_property_id text := nullif(v_json->>'assigned_property_id','');
  v_session_id uuid := nullif(v_json->>'session_id','')::uuid;
  v_burst_id uuid := nullif(v_json->>'burst_id','')::uuid;
  v_application_id text := nullif(v_json->>'application_id','');
  v_work_order_id text := nullif(v_json->>'work_order_id','');
  v_lease_id text := nullif(v_json->>'lease_id','');
  v_scheduling_state_id uuid := nullif(v_json->>'scheduling_state_id','')::uuid;
  v_property_workspace uuid; v_assigned_property_workspace uuid; v_session_workspace uuid; v_burst_workspace uuid;
  v_application_workspace uuid; v_work_order_workspace uuid; v_lease_workspace uuid; v_scheduling_state_workspace uuid;
  v_property_exists boolean := false; v_assigned_property_exists boolean := false;
  v_session_exists boolean := false; v_burst_exists boolean := false; v_application_exists boolean := false;
  v_work_order_exists boolean := false; v_lease_exists boolean := false; v_scheduling_state_exists boolean := false;
  v_key text; v_value text; v_user_id uuid; v_workspace uuid; v_profile record;
  v_workspaces uuid[] := '{}'::uuid[];
  v_has_normal_account_ref boolean := false;
  v_expected uuid;
begin
  -- Do not coalesce principals. A row can carry more than one identity and
  -- every populated identity must agree, including vendor and legacy fields.
  foreach v_key in array array['manager_user_id','landlord_id','owner_user_id','user_id','resident_user_id','related_user_id','test_actor_user_id','vendor_user_id'] loop
    v_value := nullif(v_json->>v_key,'');
    if v_value is null then continue; end if;
    begin v_user_id := v_value::uuid; exception when invalid_text_representation then raise exception 'invalid account reference'; end;
    v_workspace := null;
    -- Membership is the durable classification and survives profile/Auth
    -- removal. Consult it before asking whether a normal profile exists.
    select workspace_id into v_workspace from public.test_workspace_members where user_id=v_user_id limit 1;
    if found then v_workspaces := array_append(v_workspaces,v_workspace);
    elsif exists(select 1 from public.profiles where id=v_user_id) then v_has_normal_account_ref := true;
    end if;
  end loop;
  foreach v_key in array array['owner_user_id','inviter_user_id','invitee_user_id','accepted_user_id'] loop
    v_value := nullif(v_json->>v_key,'');
    if v_value is null then continue; end if;
    begin v_user_id := v_value::uuid; exception when invalid_text_representation then raise exception 'invalid account reference'; end;
    v_workspace := null;
    select workspace_id into v_workspace from public.test_workspace_members where user_id=v_user_id limit 1;
    if found then v_workspaces := array_append(v_workspaces,v_workspace);
    elsif exists(select 1 from public.profiles where id=v_user_id) then v_has_normal_account_ref := true;
    end if;
  end loop;
  -- Contact addresses are permitted only when no profile exists. Every profile
  -- with that email is inspected independently, avoiding email collisions from
  -- silently choosing the first row.
  foreach v_key in array array['email','resident_email','related_email','contact_email','vendor_email','participant_email','recipient_email'] loop
    v_value := lower(nullif(trim(v_json->>v_key),''));
    if v_value is null then continue; end if;
    for v_profile in select p.id,m.workspace_id from public.profiles p left join public.test_workspace_members m on m.user_id=p.id where lower(p.email)=v_value loop
      if v_profile.workspace_id is null then v_has_normal_account_ref := true; else v_workspaces := array_append(v_workspaces,v_profile.workspace_id); end if;
    end loop;
  end loop;
  v_value := lower(nullif(trim(v_json#>>'{row_data,email}'),''));
  if v_value is not null then
    for v_profile in select p.id,m.workspace_id from public.profiles p left join public.test_workspace_members m on m.user_id=p.id where lower(p.email)=v_value loop
      if v_profile.workspace_id is null then v_has_normal_account_ref := true; else v_workspaces := array_append(v_workspaces,v_profile.workspace_id); end if;
    end loop;
  end if;
  if v_property_id is not null then
    select true, test_workspace_id into v_property_exists, v_property_workspace from public.manager_property_records where id=v_property_id limit 1;
  end if;
  if v_assigned_property_id is not null then
    select true, test_workspace_id into v_assigned_property_exists, v_assigned_property_workspace from public.manager_property_records where id=v_assigned_property_id limit 1;
  end if;
  if v_session_id is not null then
    select true, test_workspace_id into v_session_exists, v_session_workspace from public.agent_sessions where id=v_session_id limit 1;
  end if;
  if v_burst_id is not null then
    select true, test_workspace_id into v_burst_exists, v_burst_workspace from public.prospect_sms_bursts where id=v_burst_id limit 1;
  end if;
  if v_application_id is not null then
    select true, test_workspace_id into v_application_exists, v_application_workspace from public.manager_application_records where id=v_application_id limit 1;
  end if;
  if v_work_order_id is not null then
    select true, test_workspace_id into v_work_order_exists, v_work_order_workspace from public.portal_work_order_records where id=v_work_order_id limit 1;
  end if;
  if v_lease_id is not null then
    select true, test_workspace_id into v_lease_exists, v_lease_workspace from public.portal_lease_pipeline_records where id=v_lease_id limit 1;
  end if;
  if v_scheduling_state_id is not null then
    select true, test_workspace_id into v_scheduling_state_exists, v_scheduling_state_workspace from public.prospect_tour_scheduling_state where id=v_scheduling_state_id limit 1;
  end if;
  foreach v_workspace in array array[v_property_workspace,v_assigned_property_workspace,v_session_workspace,v_burst_workspace,v_application_workspace,v_work_order_workspace,v_lease_workspace,v_scheduling_state_workspace] loop
    if v_workspace is not null then v_workspaces := array_append(v_workspaces,v_workspace); end if;
  end loop;
  select w into v_expected from unnest(v_workspaces) w limit 1;
  if exists(select 1 from unnest(v_workspaces) w where w<>v_expected) then raise exception 'cross-workspace relationship refused'; end if;
  if v_expected is not null and v_has_normal_account_ref then raise exception 'test workspace cannot reference a normal account'; end if;
  if v_expected is not null and (
    (v_property_exists and v_property_workspace is null) or (v_assigned_property_exists and v_assigned_property_workspace is null)
    or (v_session_exists and v_session_workspace is null) or (v_burst_exists and v_burst_workspace is null)
    or (v_application_exists and v_application_workspace is null) or (v_work_order_exists and v_work_order_workspace is null)
    or (v_lease_exists and v_lease_workspace is null) or (v_scheduling_state_exists and v_scheduling_state_workspace is null)
  ) then raise exception 'test workspace cannot reference a normal parent'; end if;
  if new.test_workspace_id is not null and new.test_workspace_id is distinct from v_expected then
    raise exception 'caller-supplied test workspace refused';
  end if;
  if tg_op='UPDATE' and old.test_workspace_id is not null and old.test_workspace_id is distinct from v_expected then
    raise exception 'test workspace provenance is immutable';
  end if;
  new.test_workspace_id := v_expected;
  return new;
end;
$$;

create or replace function public.prevent_test_workspace_global_schedule_singleton()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.id in ('axis_admin_planned_events_v1','axis_admin_partner_inquiries_v1') and new.test_workspace_id is not null then
    raise exception 'test workspace schedule cannot use a global singleton';
  end if;
  return new;
end;
$$;
drop trigger if exists prevent_test_workspace_global_schedule_singleton on public.portal_schedule_records;
create trigger prevent_test_workspace_global_schedule_singleton before insert or update on public.portal_schedule_records
  for each row execute function public.prevent_test_workspace_global_schedule_singleton();

-- One namespaced lifecycle owns both customer and private-workspace tours.
create or replace function public.mutate_confirmed_tour_schedule_namespace(
  p_workspace_id uuid,
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

  -- One lifecycle algorithm owns both namespaces. Only storage selection and
  -- exact row scope vary; CAS, conflict, reservation, booking and inquiry rules do not.
  perform pg_advisory_xact_lock(hashtextextended(case when p_workspace_id is null
    then 'proplane:confirmed-tour-schedule'
    else 'proplane:confirmed-tour-schedule:'||p_workspace_id::text end,0));
  if p_workspace_id is null then
    select coalesce(row_data->'payload','[]'::jsonb) into v_planned from public.portal_schedule_records where id='axis_admin_planned_events_v1' for update;
    if not found then v_planned := '[]'::jsonb; end if;
    select coalesce(row_data->'payload','[]'::jsonb) into v_inquiries from public.portal_schedule_records where id='axis_admin_partner_inquiries_v1' for update;
    if not found then v_inquiries := '[]'::jsonb; end if;
  else
    if not exists(select 1 from public.test_workspaces where id=p_workspace_id) then raise exception 'unknown test workspace'; end if;
    select coalesce(row_data->'payload','[]'::jsonb) into v_planned from public.test_workspace_schedule_records where workspace_id=p_workspace_id and record_key='planned_events' for update;
    if not found then v_planned := '[]'::jsonb; end if;
    select coalesce(row_data->'payload','[]'::jsonb) into v_inquiries from public.test_workspace_schedule_records where workspace_id=p_workspace_id and record_key='partner_inquiries' for update;
    if not found then v_inquiries := '[]'::jsonb; end if;
  end if;

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
      where r.manager_user_id=v_manager and r.status='active' and r.test_workspace_id is not distinct from p_workspace_id
        and r.planned_event_id <> v_event_id
        and (r.slot_key = v_slot_key or (r.starts_at < v_end and v_start < r.ends_at))
    ) then
      return jsonb_build_object('ok',false,'reason','conflict');
    end if;
    if not p_allow_conflict then
      insert into public.tour_slot_reservations(manager_user_id,property_id,slot_key,starts_at,ends_at,planned_event_id,test_workspace_id)
      values (v_manager,nullif(p_event->>'propertyId',''),v_slot_key,v_start,v_end,v_event_id,p_workspace_id)
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
    update public.tour_slot_reservations set status='cancelled',updated_at=now() where planned_event_id=v_event_id and status='active' and test_workspace_id is not distinct from p_workspace_id;
    update public.prospect_tour_bookings set status='cancelled',updated_at=now() where planned_event_id=v_event_id and status in ('confirmed','rescheduled') and test_workspace_id is not distinct from p_workspace_id;
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
      where r.manager_user_id=v_manager and r.status='active' and r.test_workspace_id is not distinct from p_workspace_id
        and r.planned_event_id <> v_event_id
        and (r.slot_key = v_slot_key or (r.starts_at < v_end and v_start < r.ends_at))
    ) then return jsonb_build_object('ok',false,'reason','conflict'); end if;
    update public.tour_slot_reservations set status='rescheduled',updated_at=now()
      where planned_event_id=v_event_id and status='active' and test_workspace_id is not distinct from p_workspace_id;
    insert into public.tour_slot_reservations(manager_user_id,property_id,slot_key,starts_at,ends_at,planned_event_id,status,test_workspace_id)
    values(v_manager,nullif(p_event->>'propertyId',''),v_slot_key,v_start,v_end,v_event_id,'active',p_workspace_id)
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
    update public.tour_slot_reservations set status='cancelled',updated_at=now() where planned_event_id=v_event_id and status='active' and test_workspace_id is not distinct from p_workspace_id;
    update public.prospect_tour_bookings set status='cancelled',updated_at=now() where planned_event_id=v_event_id and status in ('confirmed','rescheduled') and test_workspace_id is not distinct from p_workspace_id;
  else
    v_next := (select coalesce(jsonb_agg(case when e->>'id'=v_event_id then p_event else e end),'[]'::jsonb) from jsonb_array_elements(v_planned) e);
    v_exists := exists(select 1 from jsonb_array_elements(v_planned) e where e->>'id'=v_event_id);
    if not v_exists then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  end if;

  if p_workspace_id is null then
    insert into public.portal_schedule_records(id,manager_user_id,property_id,record_type,starts_at,ends_at,row_data,updated_at)
    values('axis_admin_planned_events_v1',null,null,'axis_admin_planned_events_v1',null,null,jsonb_build_object('id','axis_admin_planned_events_v1','recordType','axis_admin_planned_events_v1','managerUserId',null,'propertyId',null,'payload',v_next),now())
    on conflict(id) do update set row_data=excluded.row_data,updated_at=excluded.updated_at;
  else
    insert into public.test_workspace_schedule_records(workspace_id,record_key,row_data,updated_at)
    values(p_workspace_id,'planned_events',jsonb_build_object('id','axis_admin_planned_events_v1','recordType','axis_admin_planned_events_v1','managerUserId',null,'propertyId',null,'payload',v_next),now())
    on conflict(workspace_id,record_key) do update set row_data=excluded.row_data,updated_at=excluded.updated_at;
  end if;
  if cardinality(p_remove_inquiry_ids)>0 then
    v_inquiries := (select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(v_inquiries) e where not(e->>'id'=any(p_remove_inquiry_ids)));
    if p_workspace_id is null then
      update public.portal_schedule_records set row_data=jsonb_build_object('id','axis_admin_partner_inquiries_v1','recordType','axis_admin_partner_inquiries_v1','managerUserId',null,'propertyId',null,'payload',v_inquiries),updated_at=now() where id='axis_admin_partner_inquiries_v1';
    else
      insert into public.test_workspace_schedule_records(workspace_id,record_key,row_data,updated_at) values(p_workspace_id,'partner_inquiries',jsonb_build_object('id','axis_admin_partner_inquiries_v1','recordType','axis_admin_partner_inquiries_v1','managerUserId',null,'propertyId',null,'payload',v_inquiries),now()) on conflict(workspace_id,record_key) do update set row_data=excluded.row_data,updated_at=excluded.updated_at;
    end if;
    delete from public.portal_schedule_records r where r.record_type='partner_inquiry_request' and r.test_workspace_id is not distinct from p_workspace_id and exists(select 1 from unnest(p_remove_inquiry_ids) inquiry_id where r.id like 'partner_inquiry_request_'||inquiry_id||'_%');
  end if;
  return jsonb_build_object('ok',true,'event',p_event);
end; $$;

create or replace function public.mutate_confirmed_tour_schedule_core(
  p_operation text,p_event jsonb,p_remove_inquiry_ids text[] default '{}'::text[],p_allow_conflict boolean default false,
  p_expected_start timestamptz default null,p_expected_end timestamptz default null,p_expected_generation text default null,p_expected_generation_known boolean default false
) returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.mutate_confirmed_tour_schedule_namespace(null,p_operation,p_event,p_remove_inquiry_ids,p_allow_conflict,p_expected_start,p_expected_end,p_expected_generation,p_expected_generation_known)
$$;

create or replace function public.mutate_confirmed_tour_schedule(
  p_operation text,p_event jsonb,p_remove_inquiry_ids text[] default '{}'::text[],p_allow_conflict boolean default false,
  p_expected_start timestamptz default null,p_expected_end timestamptz default null,p_expected_generation text default null,p_expected_generation_known boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_event jsonb := coalesce(p_event,'{}'::jsonb);
  v_existing jsonb; v_provenance jsonb;
  v_event_id text := nullif(trim(v_event->>'id'),'');
  v_manager uuid; v_actor uuid; v_property_id text := nullif(v_event->>'propertyId','');
  v_marker uuid; v_workspace uuid; v_candidate uuid; v_manager_is_normal boolean := false;
begin
  if p_operation not in ('append','append_event','cancel','delete','replace','patch') or v_event_id is null then raise exception 'invalid tour schedule mutation'; end if;
  begin v_manager := nullif(v_event->>'managerUserId','')::uuid; exception when invalid_text_representation then raise exception 'invalid schedule manager'; end;
  if jsonb_typeof(v_event->'smsTestProvenance')='object' then
    begin v_marker := nullif(v_event#>>'{smsTestProvenance,workspaceId}','')::uuid; exception when invalid_text_representation then raise exception 'invalid test workspace provenance'; end;
    begin v_actor := nullif(v_event#>>'{smsTestProvenance,actorUserId}','')::uuid; exception when invalid_text_representation then raise exception 'invalid test actor provenance'; end;
  end if;

  if v_manager is not null then
    select workspace_id into v_candidate from public.test_workspace_members where user_id=v_manager;
    if found then v_workspace := v_candidate;
    elsif exists(select 1 from public.profiles where id=v_manager) then v_manager_is_normal := true;
    else raise exception 'unknown schedule manager'; end if;
  end if;
  if v_actor is not null then
    select workspace_id into v_candidate from public.test_workspace_members where user_id=v_actor;
    if not found then raise exception 'unknown test actor'; end if;
    if v_manager_is_normal then raise exception 'test actor workspace mismatch'; end if;
    if v_workspace is not null and v_candidate is distinct from v_workspace then raise exception 'test actor workspace mismatch'; end if;
    v_workspace := v_candidate;
  end if;
  if v_property_id is not null then
    select test_workspace_id into v_candidate from public.manager_property_records where id=v_property_id;
    if not found then raise exception 'unknown schedule property'; end if;
    if v_workspace is distinct from v_candidate then raise exception 'schedule property workspace mismatch'; end if;
    v_workspace := v_candidate;
  end if;
  if v_marker is not null and (v_workspace is null or v_marker is distinct from v_workspace) then raise exception 'test workspace marker mismatch'; end if;

  perform pg_advisory_xact_lock(hashtextextended(case when v_workspace is null
    then 'proplane:confirmed-tour-schedule'
    else 'proplane:confirmed-tour-schedule:'||v_workspace::text end,0));
  if v_workspace is null then
    select value into v_existing from public.portal_schedule_records r,jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value where r.id='axis_admin_planned_events_v1' and value->>'id'=v_event_id for update;
  else
    select value into v_existing from public.test_workspace_schedule_records r,jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value where r.workspace_id=v_workspace and r.record_key='planned_events' and value->>'id'=v_event_id for update;
  end if;
  v_provenance := case
    when jsonb_typeof(v_event->'smsTestProvenance')='object' and coalesce(trim(v_event#>>'{smsTestProvenance,actorUserId}'),'')<>'' and coalesce(trim(v_event#>>'{smsTestProvenance,managerUserId}'),'')<>'' and coalesce(trim(v_event#>>'{smsTestProvenance,sessionId}'),'')<>'' then v_event->'smsTestProvenance'
    when jsonb_typeof(v_existing->'smsTestProvenance')='object' and coalesce(trim(v_existing#>>'{smsTestProvenance,actorUserId}'),'')<>'' and coalesce(trim(v_existing#>>'{smsTestProvenance,managerUserId}'),'')<>'' and coalesce(trim(v_existing#>>'{smsTestProvenance,sessionId}'),'')<>'' then v_existing->'smsTestProvenance'
    else null end;
  if v_provenance is not null then
    v_event := v_event||jsonb_build_object('smsTestProvenance',v_provenance,'smsTestSessionId',v_provenance->>'sessionId');
    if p_operation in ('cancel','delete') and v_existing is not null and v_existing->'smsTestProvenance' is distinct from v_provenance then
      if v_workspace is null then
        update public.portal_schedule_records r set row_data=r.row_data||jsonb_build_object('payload',(
          select coalesce(jsonb_agg(case when value->>'id'=v_event_id then value||jsonb_build_object('smsTestProvenance',v_provenance,'smsTestSessionId',v_provenance->>'sessionId') else value end),'[]'::jsonb)
          from jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value)),updated_at=now()
        where r.id='axis_admin_planned_events_v1';
      else
        update public.test_workspace_schedule_records r set row_data=r.row_data||jsonb_build_object('payload',(
          select coalesce(jsonb_agg(case when value->>'id'=v_event_id then value||jsonb_build_object('smsTestProvenance',v_provenance,'smsTestSessionId',v_provenance->>'sessionId') else value end),'[]'::jsonb)
          from jsonb_array_elements(coalesce(r.row_data->'payload','[]'::jsonb)) value)),updated_at=now()
        where r.workspace_id=v_workspace and r.record_key='planned_events';
      end if;
    end if;
  end if;
  return public.mutate_confirmed_tour_schedule_namespace(v_workspace,p_operation,v_event,p_remove_inquiry_ids,p_allow_conflict,p_expected_start,p_expected_end,p_expected_generation,p_expected_generation_known);
end;
$$;

revoke execute on function public.mutate_confirmed_tour_schedule_namespace(uuid,text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) from public,anon,authenticated;
grant execute on function public.mutate_confirmed_tour_schedule_namespace(uuid,text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) to service_role;
revoke execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) from public,anon,authenticated;
grant execute on function public.mutate_confirmed_tour_schedule(text,jsonb,text[],boolean,timestamptz,timestamptz,text,boolean) to service_role;

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
  if p_manager_user_id is null or jsonb_typeof(p_events)<>'array' or jsonb_typeof(p_expected_events)<>'array' then
    return jsonb_build_object('ok',false,'reason','invalid_payload');
  end if;
  if public.test_workspace_for_user(p_manager_user_id) is distinct from p_workspace_id then
    return jsonb_build_object('ok',false,'reason','workspace_mismatch');
  end if;
  if exists(select 1 from jsonb_array_elements(p_events) value where nullif(trim(value->>'id'),'') is null or value->>'managerUserId'<>p_manager_user_id::text) then
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
  if jsonb_typeof(v_events)<>'array' then v_events := '[]'::jsonb; end if;
  if (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb) from jsonb_array_elements(v_events) value where value->>'managerUserId'=p_manager_user_id::text)
    <> (select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb) from jsonb_array_elements(p_expected_events) value) then
    return jsonb_build_object('ok',false,'reason','stale_schedule');
  end if;
  select coalesce(jsonb_agg(value),'[]'::jsonb) into v_next from jsonb_array_elements(v_events) value where value->>'managerUserId'<>p_manager_user_id::text;
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

do $$ declare v_table text; begin
  foreach v_table in array array[
    'manager_property_records','manager_application_records','portal_work_order_records',
    'portal_service_request_records','portal_household_charge_records','portal_schedule_records',
    'portal_lease_pipeline_records','portal_pro_relationship_records','portal_scheduled_inbox_message_records',
    'agent_sessions','agent_pending_actions','prospect_sms_bursts','prospect_tour_scheduling_state',
    'tour_slot_reservations','prospect_tour_bookings'
    ,'portal_inbox_thread_records','account_link_invites','vendor_invites'
  ] loop
    execute format('drop trigger if exists derive_test_workspace_provenance on public.%I',v_table);
    execute format('create trigger derive_test_workspace_provenance before insert or update on public.%I for each row execute function public.derive_test_workspace_provenance()',v_table);
  end loop;
end $$;

create or replace function public.inherit_agent_message_test_workspace()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_workspace uuid;
begin
  select test_workspace_id into v_workspace from public.agent_sessions where id=new.session_id;
  if new.test_workspace_id is not null and new.test_workspace_id is distinct from v_workspace then
    raise exception 'caller-supplied test workspace refused';
  end if;
  if tg_op='UPDATE' and old.test_workspace_id is not null and old.test_workspace_id is distinct from v_workspace then
    raise exception 'test workspace provenance is immutable';
  end if;
  new.test_workspace_id := v_workspace;
  return new;
end;
$$;
drop trigger if exists inherit_agent_message_test_workspace on public.agent_messages;
create trigger inherit_agent_message_test_workspace before insert or update on public.agent_messages
  for each row execute function public.inherit_agent_message_test_workspace();

create or replace function public.prevent_test_workspace_provenance_change()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if old.test_workspace_id is not null and old.test_workspace_id is distinct from new.test_workspace_id then
    raise exception 'test workspace provenance is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists agent_sessions_test_workspace_immutable on public.agent_sessions;
create trigger agent_sessions_test_workspace_immutable before update on public.agent_sessions
  for each row execute function public.prevent_test_workspace_provenance_change();
drop trigger if exists agent_messages_test_workspace_immutable on public.agent_messages;
create trigger agent_messages_test_workspace_immutable before update on public.agent_messages
  for each row execute function public.prevent_test_workspace_provenance_change();
drop trigger if exists audit_log_test_workspace_immutable on public.audit_log;
create trigger audit_log_test_workspace_immutable before update on public.audit_log
  for each row execute function public.prevent_test_workspace_provenance_change();

alter table public.test_workspaces enable row level security;
alter table public.test_workspace_members enable row level security;
revoke all on table public.test_workspaces, public.test_workspace_members from public, anon, authenticated;
grant select on table public.test_workspaces, public.test_workspace_members to authenticated;

-- A signed-in account may read only its own classification and workspace. No
-- client role receives INSERT, UPDATE, or DELETE privileges.
drop policy if exists test_workspace_members_select_own on public.test_workspace_members;
create policy test_workspace_members_select_own on public.test_workspace_members
  for select to authenticated using (user_id = auth.uid());
drop policy if exists test_workspaces_select_own on public.test_workspaces;
create policy test_workspaces_select_own on public.test_workspaces
  for select to authenticated using (
    exists (
      select 1 from public.test_workspace_members m
      where m.workspace_id = test_workspaces.id and m.user_id = auth.uid()
    )
  );

-- Safe, identity-derived client lookup. It exposes no membership roster and is
-- also useful to direct PostgREST clients that cannot safely join by arbitrary id.
create or replace function public.current_test_workspace_membership()
returns table (
  workspace_id uuid,
  workspace_name text,
  workspace_status text,
  portal_role text,
  state text,
  expires_at timestamptz
)
language sql stable security invoker set search_path=public,pg_temp as $$
  select w.id, w.name, w.status, m.portal_role, m.state, m.expires_at
  from public.test_workspace_members m
  join public.test_workspaces w on w.id = m.workspace_id
  where m.user_id = auth.uid();
$$;
revoke all on function public.current_test_workspace_membership() from public, anon;
grant execute on function public.current_test_workspace_membership() to authenticated;

-- Test listings are private workspace data even when their ordinary listing
-- status is `live`. Manager self-access continues through the existing own-row
-- policy; anonymous and unrelated authenticated readers see only customer rows.
drop policy if exists "manager_property_records_select_live" on public.manager_property_records;
create policy "manager_property_records_select_live"
  on public.manager_property_records for select
  using (status='live' and test_workspace_id is null);
