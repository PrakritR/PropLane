-- Server-owned coordination. This migration is additive and has no production side effects until applied.
alter table public.work_order_bids alter column vendor_user_id drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'work_order_bids_vendor_identity_check') then
    alter table public.work_order_bids add constraint work_order_bids_vendor_identity_check
      check (vendor_user_id is not null or vendor_directory_id is not null);
  end if;
end $$;
-- Fail visibly if old writes produced duplicate identities or accepted winners.
do $$ begin
  if exists (select 1 from public.work_order_bids where vendor_directory_id is not null
    group by work_order_id, vendor_directory_id having count(*) > 1) then
    raise exception 'duplicate directory bids need review before vendor coordination migration';
  end if;
  if exists (select 1 from public.work_order_bids where status = 'accepted'
    group by work_order_id having count(*) > 1) then
    raise exception 'multiple accepted bids need review before vendor coordination migration';
  end if;
end $$;
create unique index if not exists work_order_bids_directory_unique
  on public.work_order_bids(work_order_id, vendor_directory_id) where vendor_directory_id is not null;
create unique index if not exists work_order_bids_one_accepted_per_service
  on public.work_order_bids(work_order_id) where status = 'accepted';

create or replace function public.keep_accepted_work_order_bid_price()
returns trigger language plpgsql as $$
begin
  if old.status = 'accepted' and (
    new.amount_cents is distinct from old.amount_cents or
    new.materials_cents is distinct from old.materials_cents or
    new.vendor_directory_id is distinct from old.vendor_directory_id or
    new.work_order_id is distinct from old.work_order_id or
    new.status is distinct from old.status or
    (old.vendor_user_id is not null and new.vendor_user_id is distinct from old.vendor_user_id)
  ) then raise exception 'accepted bid price and identity are immutable'; end if;
  if old.status = 'accepted' and old.vendor_user_id is null and new.vendor_user_id is not null
    and not exists (select 1 from public.manager_vendor_records d
      where d.id = old.vendor_directory_id and d.manager_user_id = old.manager_user_id
        and d.vendor_user_id = new.vendor_user_id) then
    raise exception 'accepted bid account link does not match directory';
  end if;
  return new;
end $$;
drop trigger if exists keep_accepted_work_order_bid_price on public.work_order_bids;
create trigger keep_accepted_work_order_bid_price before update on public.work_order_bids
  for each row execute function public.keep_accepted_work_order_bid_price();

create table if not exists public.vendor_coordination_phone_bindings (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records(id) on delete cascade,
  vendor_user_id uuid references auth.users(id) on delete set null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (manager_user_id, vendor_directory_id)
);
create unique index if not exists vendor_coordination_phone_owner_unique
  on public.vendor_coordination_phone_bindings(manager_user_id, phone_e164) where revoked_at is null;
create index if not exists vendor_coordination_phone_user_idx
  on public.vendor_coordination_phone_bindings(vendor_user_id) where revoked_at is null;

create table if not exists public.vendor_coordination_phone_challenges (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 5),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists vendor_coordination_challenge_lookup_idx
  on public.vendor_coordination_phone_challenges(manager_user_id, vendor_directory_id, created_at desc);

create table if not exists public.vendor_coordination_proposals (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.portal_work_order_records(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records(id) on delete restrict,
  vendor_user_id uuid references auth.users(id) on delete set null,
  visit_type text not null check (visit_type in ('consultation','repair')),
  version integer not null default 1 check (version > 0),
  quote_revision integer not null default 0 check (quote_revision >= 0),
  status text not null default 'collecting' check (status in ('collecting','ready','approved','declined','cancelled')),
  labor_cents integer check (labor_cents between 0 and 1000000000),
  materials_cents integer check (materials_cents between 0 and 1000000000),
  consultation_fee_cents integer check (consultation_fee_cents between 0 and 1000000000),
  scope text,
  exclusions text,
  duration_minutes integer check (duration_minutes between 15 and 480),
  vendor_windows jsonb not null default '[]'::jsonb check (jsonb_typeof(vendor_windows) = 'array'),
  resident_windows jsonb not null default '[]'::jsonb check (jsonb_typeof(resident_windows) = 'array'),
  selected_start_at timestamptz,
  vendor_confirmed_revision integer,
  resident_confirmed_revision integer,
  revision_reason text,
  manager_takeover boolean not null default false,
  takeover_reason text,
  takeover_at timestamptz,
  source_message_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(source_message_ids) = 'array'),
  accepted_bid_id uuid references public.work_order_bids(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_order_id, vendor_directory_id, visit_type)
);
create index if not exists vendor_coordination_work_order_idx
  on public.vendor_coordination_proposals(work_order_id, status);
create index if not exists vendor_coordination_vendor_idx
  on public.vendor_coordination_proposals(vendor_user_id, status);

create table if not exists public.vendor_coordination_operations (
  proposal_id uuid not null references public.vendor_coordination_proposals(id) on delete cascade,
  source_message_id text not null,
  action_kind text not null,
  input_hash text not null,
  created_at timestamptz not null default now(),
  primary key (proposal_id, source_message_id, action_kind)
);

create table if not exists public.vendor_coordination_reservations (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null unique references public.vendor_coordination_proposals(id) on delete cascade,
  work_order_id text not null references public.portal_work_order_records(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  vendor_directory_id text not null references public.manager_vendor_records(id) on delete restrict,
  vendor_user_id uuid references auth.users(id) on delete set null,
  vendor_phone_e164 text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  status text not null default 'active' check (status in ('active','cancelled')),
  created_at timestamptz not null default now()
);
create index if not exists vendor_coordination_reservation_phone_idx
  on public.vendor_coordination_reservations(vendor_phone_e164, starts_at) where status = 'active';
create index if not exists vendor_coordination_reservation_user_idx
  on public.vendor_coordination_reservations(vendor_user_id, starts_at) where status = 'active';

-- Existing snapshots may update unrelated fields, but not enrolled booking terms.
create or replace function public.guard_enrolled_vendor_coordination_work_order()
returns trigger language plpgsql as $$
declare v_field text;
begin
  if current_setting('proplane.vendor_coordination_write', true) = 'on' then return new; end if;
  if not exists (select 1 from public.vendor_coordination_proposals p where p.work_order_id = old.id
    and p.status not in ('cancelled','declined')) then return new; end if;
  foreach v_field in array array['scheduledAtIso','consultationVisitAt','vendorId','vendorCostCents',
    'materialsCostCents','cost','biddingOpen','visitDurationMinutes','consultationFeeCents'] loop
    if new.row_data->v_field is distinct from old.row_data->v_field then
      raise exception 'enrolled service % is controlled by vendor coordination', old.id;
    end if;
  end loop;
  if new.vendor_user_id is distinct from old.vendor_user_id then
    if not (old.vendor_user_id is null and new.vendor_user_id is not null and exists (
      select 1 from public.manager_vendor_records d where d.id = old.row_data->>'vendorId'
        and d.manager_user_id = old.manager_user_id and d.vendor_user_id = new.vendor_user_id
    )) then raise exception 'enrolled service vendor assignment is controlled by vendor coordination'; end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_enrolled_vendor_coordination_work_order on public.portal_work_order_records;
create trigger guard_enrolled_vendor_coordination_work_order before update on public.portal_work_order_records
  for each row execute function public.guard_enrolled_vendor_coordination_work_order();

-- New records are service-readable only. APIs must scope reads after authenticating an actor.
alter table public.vendor_coordination_phone_bindings enable row level security;
alter table public.vendor_coordination_phone_challenges enable row level security;
alter table public.vendor_coordination_proposals enable row level security;
alter table public.vendor_coordination_operations enable row level security;
alter table public.vendor_coordination_reservations enable row level security;
revoke all on public.vendor_coordination_phone_bindings, public.vendor_coordination_phone_challenges,
  public.vendor_coordination_proposals, public.vendor_coordination_reservations,
  public.vendor_coordination_operations from anon, authenticated;
grant select, insert, update, delete on public.vendor_coordination_phone_bindings, public.vendor_coordination_phone_challenges,
  public.vendor_coordination_proposals, public.vendor_coordination_reservations,
  public.vendor_coordination_operations to service_role;

-- Challenge creation and verification are service-only. Caller sends the code by the manager work number;
-- these functions never deliver or expose it. Hash input must include an application secret.
create or replace function public.issue_vendor_coordination_phone_challenge(
  p_manager_user_id uuid, p_vendor_directory_id text, p_phone_e164 text, p_code_hash text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' or length(p_code_hash) < 32 or not exists (
    select 1 from public.manager_vendor_records d where d.id = p_vendor_directory_id and d.manager_user_id = p_manager_user_id
  ) then raise exception 'invalid vendor phone challenge'; end if;
  update public.vendor_coordination_phone_challenges set consumed_at = now()
    where manager_user_id = p_manager_user_id and vendor_directory_id = p_vendor_directory_id and consumed_at is null;
  insert into public.vendor_coordination_phone_challenges(manager_user_id,vendor_directory_id,phone_e164,code_hash,expires_at)
    values (p_manager_user_id,p_vendor_directory_id,p_phone_e164,p_code_hash,now() + interval '10 minutes') returning id into v_id;
  return v_id;
end $$;
create or replace function public.verify_vendor_coordination_phone_challenge(
  p_challenge_id uuid, p_code_hash text
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_challenge public.vendor_coordination_phone_challenges%rowtype; v_vendor_user_id uuid;
begin
  select * into v_challenge from public.vendor_coordination_phone_challenges where id = p_challenge_id for update;
  if not found or v_challenge.consumed_at is not null or v_challenge.expires_at <= now() or v_challenge.attempts >= 5 then return false; end if;
  update public.vendor_coordination_phone_challenges set attempts = attempts + 1 where id = p_challenge_id;
  if v_challenge.code_hash <> p_code_hash then return false; end if;
  select vendor_user_id into v_vendor_user_id from public.manager_vendor_records
    where id = v_challenge.vendor_directory_id and manager_user_id = v_challenge.manager_user_id;
  if not found then return false; end if;
  if exists (select 1 from public.vendor_coordination_phone_bindings b
    where b.manager_user_id = v_challenge.manager_user_id and b.phone_e164 = v_challenge.phone_e164
      and b.vendor_directory_id <> v_challenge.vendor_directory_id and b.revoked_at is null) then
    raise exception 'ambiguous vendor phone binding';
  end if;
  update public.vendor_coordination_phone_bindings set revoked_at = now()
    where manager_user_id = v_challenge.manager_user_id and vendor_directory_id = v_challenge.vendor_directory_id and revoked_at is null;
  insert into public.vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,vendor_user_id,phone_e164)
    values(v_challenge.manager_user_id,v_challenge.vendor_directory_id,v_vendor_user_id,v_challenge.phone_e164)
    on conflict(manager_user_id,vendor_directory_id) do update set
      vendor_user_id = excluded.vendor_user_id, phone_e164 = excluded.phone_e164,
      verified_at = now(), revoked_at = null;
  update public.vendor_coordination_phone_challenges set consumed_at = now() where id = p_challenge_id;
  return true;
end $$;
revoke all on function public.issue_vendor_coordination_phone_challenge(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.verify_vendor_coordination_phone_challenge(uuid,text) from public,anon,authenticated;
grant execute on function public.issue_vendor_coordination_phone_challenge(uuid,text,text,text) to service_role;
grant execute on function public.verify_vendor_coordination_phone_challenge(uuid,text) to service_role;

-- A changed account phone invalidates all account-backed SMS bindings until reverified.
create or replace function public.invalidate_vendor_coordination_phone_binding()
returns trigger language plpgsql as $$
begin
  if new.phone is distinct from old.phone then
    update public.vendor_coordination_phone_bindings set revoked_at = now()
      where vendor_user_id = new.id and revoked_at is null;
  end if;
  return new;
end $$;
drop trigger if exists invalidate_vendor_coordination_phone_binding on public.profiles;
create trigger invalidate_vendor_coordination_phone_binding after update of phone on public.profiles
  for each row execute function public.invalidate_vendor_coordination_phone_binding();

create or replace function public.invalidate_directory_vendor_coordination_phone_binding()
returns trigger language plpgsql as $$
begin
  if new.row_data->>'phone' is distinct from old.row_data->>'phone' then
    update public.vendor_coordination_phone_bindings set revoked_at = now()
      where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and revoked_at is null;
  end if;
  if new.vendor_user_id is distinct from old.vendor_user_id then
    if old.vendor_user_id is null and new.vendor_user_id is not null then
      update public.vendor_coordination_phone_bindings set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id;
      update public.vendor_coordination_reservations set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id;
      update public.vendor_coordination_proposals set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and vendor_user_id is null;
      update public.work_order_bids set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and vendor_user_id is null;
      update public.portal_work_order_records set vendor_user_id = new.vendor_user_id
        where manager_user_id = new.manager_user_id and vendor_user_id is null
          and row_data->>'vendorId' = new.id;
    else
      -- Reassignment is a different participant; old bookings retain their historical account.
      update public.vendor_coordination_phone_bindings set revoked_at = now()
        where manager_user_id = new.manager_user_id and vendor_directory_id = new.id and revoked_at is null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists invalidate_directory_vendor_coordination_phone_binding on public.manager_vendor_records;
create trigger invalidate_directory_vendor_coordination_phone_binding after update of row_data, vendor_user_id on public.manager_vendor_records
  for each row execute function public.invalidate_directory_vendor_coordination_phone_binding();

-- One action entry point owns enrollment, revisions, exact replies, and manager booking.
-- Every caller must derive actor ids from authenticated context. The service-role grant protects
-- the RPC transport; row checks protect against a mistaken or stale caller.
create or replace function public.vendor_coordination_action(p_action jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_kind text := p_action->>'kind';
  v_proposal public.vendor_coordination_proposals%rowtype;
  v_work public.portal_work_order_records%rowtype;
  v_directory public.manager_vendor_records%rowtype;
  v_binding public.vendor_coordination_phone_bindings%rowtype;
  v_actor uuid := nullif(p_action->>'actor_user_id','')::uuid;
  v_directory_id text;
  v_visit_type text;
  v_version integer;
  v_windows jsonb;
  v_window jsonb;
  v_start timestamptz;
  v_end timestamptz;
  v_duration integer;
  v_total integer;
  v_quote jsonb;
  v_bid public.work_order_bids%rowtype;
  v_event_id uuid;
  v_identity_user uuid;
  v_verified_phone text;
  v_sender_email text;
  v_source text := nullif(left(trim(p_action->>'source_message_id'),200),'');
  v_input_hash text := md5((p_action - 'expected_version')::text);
  v_existing_hash text;
begin
  if v_kind = 'enroll' then
    v_directory_id := nullif(trim(p_action->>'vendor_directory_id'),'');
    v_visit_type := p_action->>'visit_type';
    if v_visit_type is null or v_visit_type not in ('consultation','repair')
      or v_directory_id is null or v_actor is null then
      raise exception 'invalid enrollment';
    end if;
    select * into v_work from public.portal_work_order_records where id = p_action->>'work_order_id' for update;
    if not found or v_work.manager_user_id is distinct from nullif(p_action->>'manager_user_id','')::uuid
      or v_actor is distinct from v_work.manager_user_id then raise exception 'work order owner mismatch'; end if;
    select * into v_directory from public.manager_vendor_records where id = v_directory_id;
    if not found or v_directory.manager_user_id is distinct from v_work.manager_user_id then
      raise exception 'vendor directory owner mismatch'; end if;
    if not exists (select 1 from public.work_order_vendor_offers o where o.work_order_id = v_work.id
      and o.manager_user_id = v_work.manager_user_id and o.vendor_directory_id = v_directory.id
      and o.status = 'sent' and o.expires_at > now())
      and v_work.row_data->>'vendorId' is distinct from v_directory.id then
      raise exception 'vendor has no active offer or assignment'; end if;
    insert into public.vendor_coordination_proposals
      (work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,visit_type,source_message_ids)
    values(v_work.id,v_work.manager_user_id,v_directory.id,v_directory.vendor_user_id,v_visit_type,
      case when v_source is null then '[]'::jsonb else jsonb_build_array(v_source) end)
    on conflict(work_order_id,vendor_directory_id,visit_type) do nothing;
    select * into v_proposal from public.vendor_coordination_proposals
      where work_order_id = v_work.id and vendor_directory_id = v_directory.id and visit_type = v_visit_type;
    if v_source is not null then
      select input_hash into v_existing_hash from public.vendor_coordination_operations
        where proposal_id = v_proposal.id and source_message_id = v_source and action_kind = v_kind;
      if found then
        if v_existing_hash <> v_input_hash then raise exception 'message action reused with changed input'; end if;
        return to_jsonb(v_proposal);
      end if;
    end if;
    select lower(trim(email)) into v_sender_email from public.profiles where id = v_proposal.manager_user_id;
    if nullif(v_sender_email,'') is null then raise exception 'manager sender email missing'; end if;
    insert into public.action_events(event_key,domain,event_type,category,manager_user_id,entity_id,
      sender_user_id,sender_email,occurred_at,payload)
    values('vendor_coordination:' || v_proposal.id::text || ':enrolled','work_order',
      'coordination_updated','maintenance',v_proposal.manager_user_id,v_work.id,
      v_proposal.manager_user_id,v_sender_email,now(),
      jsonb_build_object('proposalId',v_proposal.id,'visitType',v_proposal.visit_type,
        'vendorDirectoryId',v_proposal.vendor_directory_id,'version',v_proposal.version,
        'propertyId',v_work.property_id,'action','enroll'))
    on conflict(event_key) do nothing returning id into v_event_id;
    if v_event_id is not null then
      insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
        status,next_attempt_at,rendered)
      values(v_event_id,'manager',v_proposal.manager_user_id::text,v_proposal.manager_user_id,
        'pending',now(),jsonb_build_object('subject','Service coordination started',
          'text','A ' || v_proposal.visit_type || ' visit proposal was opened.'));
      if v_directory.vendor_user_id is not null or nullif(trim(v_directory.row_data->>'email'),'') is not null then
        insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
          recipient_email,status,next_attempt_at,rendered)
        values(v_event_id,'vendor',coalesce(v_directory.vendor_user_id::text,lower(trim(v_directory.row_data->>'email'))),
          v_directory.vendor_user_id,nullif(lower(trim(v_directory.row_data->>'email')),''),
          'pending',now(),jsonb_build_object('subject','Service visit proposal',
            'text','Please send your ' || v_proposal.visit_type || ' quote, duration and available windows to the manager. No visit is booked yet.'));
      end if;
      if nullif(trim(v_work.resident_email),'') is not null then
        insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_email,
          status,next_attempt_at,rendered)
        values(v_event_id,'resident',lower(trim(v_work.resident_email)),lower(trim(v_work.resident_email)),
          'pending',now(),jsonb_build_object('subject','Choose windows for a service visit',
            'text','Please submit available windows for a ' || v_proposal.visit_type || ' visit in Resident Services. No appointment is booked yet.'));
      end if;
    end if;
    if v_source is not null then
      insert into public.vendor_coordination_operations(proposal_id,source_message_id,action_kind,input_hash)
        values(v_proposal.id,v_source,v_kind,v_input_hash);
    end if;
    return to_jsonb(v_proposal);
  end if;

  select * into v_proposal from public.vendor_coordination_proposals
    where id = nullif(p_action->>'proposal_id','')::uuid for update;
  if not found then raise exception 'coordination proposal missing'; end if;
  select * into v_work from public.portal_work_order_records where id = v_proposal.work_order_id for update;
  select * into v_directory from public.manager_vendor_records where id = v_proposal.vendor_directory_id;
  if v_work.id is null or v_directory.id is null or v_work.manager_user_id is distinct from v_proposal.manager_user_id
    or v_directory.manager_user_id is distinct from v_proposal.manager_user_id then
    raise exception 'coordination owner changed'; end if;
  if not exists (select 1 from public.work_order_vendor_offers o where o.work_order_id = v_work.id
      and o.manager_user_id = v_work.manager_user_id and o.vendor_directory_id = v_directory.id
      and o.status = 'sent' and o.expires_at > now())
      and v_work.row_data->>'vendorId' is distinct from v_directory.id then
    raise exception 'vendor offer or assignment inactive'; end if;
  -- Keep the stable directory participant and attach a later account without rewriting history.
  v_identity_user := v_directory.vendor_user_id;
  update public.vendor_coordination_proposals set vendor_user_id = v_identity_user
    where id = v_proposal.id and vendor_user_id is distinct from v_identity_user;
  select * into v_binding from public.vendor_coordination_phone_bindings
    where manager_user_id = v_proposal.manager_user_id and vendor_directory_id = v_proposal.vendor_directory_id
      and revoked_at is null;
  v_verified_phone := v_binding.phone_e164;
  if v_verified_phone is null and v_identity_user is not null then
    select phone into v_verified_phone from public.profiles
      where id = v_identity_user and phone_verified_at is not null and phone ~ '^\+[1-9][0-9]{7,14}$';
  end if;
  if v_kind in ('revise_quote','submit_vendor_windows','confirm_vendor') then
    if p_action->>'vendor_directory_id' is distinct from v_proposal.vendor_directory_id
      or ((v_identity_user is null or v_actor is distinct from v_identity_user) and
        (v_binding.id is null or p_action->>'verified_phone_e164' is distinct from v_binding.phone_e164)) then
      raise exception 'vendor identity unverified'; end if;
  elsif v_kind in ('submit_resident_windows','confirm_resident') then
    if nullif(lower(trim(p_action->>'resident_email')),'') is distinct from lower(v_work.resident_email) then
      raise exception 'resident identity mismatch'; end if;
  elsif v_kind in ('select_time','approve_manager','decline_manager','cancel','request_revision','take_over') then
    if v_actor is distinct from v_proposal.manager_user_id then raise exception 'manager approval required'; end if;
  else raise exception 'unknown coordination action'; end if;
  if v_proposal.manager_takeover and v_kind in ('revise_quote','submit_vendor_windows','confirm_vendor')
    and nullif(p_action->>'verified_phone_e164','') is not null then
    raise exception 'manager has taken over SMS coordination';
  end if;
  if v_source is not null then
    select input_hash into v_existing_hash from public.vendor_coordination_operations
      where proposal_id = v_proposal.id and source_message_id = v_source and action_kind = v_kind;
    if found then
      if v_existing_hash <> v_input_hash then raise exception 'message action reused with changed input'; end if;
      return to_jsonb(v_proposal);
    end if;
  end if;
  v_version := nullif(p_action->>'expected_version','')::integer;
  if v_version is distinct from v_proposal.version then raise exception 'stale coordination version'; end if;
  if v_kind = 'cancel' and v_proposal.status = 'cancelled' then return to_jsonb(v_proposal); end if;
  if v_proposal.status in ('approved','cancelled','declined') and v_kind <> 'cancel' then
    raise exception 'coordination proposal closed'; end if;

  if v_source is not null then
    update public.vendor_coordination_proposals set source_message_ids =
      case when source_message_ids ? v_source then source_message_ids else source_message_ids || jsonb_build_array(v_source) end
      where id = v_proposal.id;
  end if;

  if v_kind in ('request_revision','take_over') then
    if nullif(trim(p_action->>'reason'),'') is null or length(trim(p_action->>'reason')) > 1000 then
      raise exception 'manager reason required'; end if;
    if v_kind = 'request_revision' then
      update public.vendor_coordination_proposals set revision_reason = trim(p_action->>'reason'),
        quote_revision = quote_revision + 1, vendor_confirmed_revision = null,
        resident_confirmed_revision = null, status = 'collecting', version = version + 1,
        updated_at = now() where id = v_proposal.id;
    else
      update public.vendor_coordination_proposals set manager_takeover = true,
        takeover_reason = trim(p_action->>'reason'), takeover_at = now(),
        version = version + 1, updated_at = now() where id = v_proposal.id;
    end if;
  elsif v_kind = 'revise_quote' then
    v_quote := p_action->'quote';
    v_duration := nullif(p_action->>'duration_minutes','')::integer;
    if jsonb_typeof(v_quote) is distinct from 'object' or v_duration is null or v_duration not between 15 and 480
      or nullif(trim(v_quote->>'scope'),'') is null or length(v_quote->>'scope') > 4000
      or length(coalesce(v_quote->>'exclusions','')) > 4000
      or coalesce(v_quote->>'laborCents','') !~ '^[0-9]{1,10}$'
      or coalesce(v_quote->>'materialsCents','') !~ '^[0-9]{1,10}$'
      or coalesce(v_quote->>'consultationFeeCents','') !~ '^[0-9]{1,10}$' then
      raise exception 'invalid coordination quote'; end if;
    if (v_quote->>'laborCents')::bigint > 1000000000 or (v_quote->>'materialsCents')::bigint > 1000000000
      or (v_quote->>'consultationFeeCents')::bigint > 1000000000 then raise exception 'quote exceeds limit'; end if;
    v_total := case when v_proposal.visit_type = 'consultation' then (v_quote->>'consultationFeeCents')::integer
      else (v_quote->>'laborCents')::integer + (v_quote->>'materialsCents')::integer end;
    if v_total > 1000000000 or (v_proposal.visit_type = 'repair' and v_total <= 0) then
      raise exception 'invalid quote total'; end if;
    update public.vendor_coordination_proposals set
      labor_cents = (v_quote->>'laborCents')::integer, materials_cents = (v_quote->>'materialsCents')::integer,
      consultation_fee_cents = (v_quote->>'consultationFeeCents')::integer,
      scope = trim(v_quote->>'scope'), exclusions = coalesce(trim(v_quote->>'exclusions'),''),
      duration_minutes = v_duration, quote_revision = quote_revision + 1,
      vendor_confirmed_revision = null, resident_confirmed_revision = null,
      status = 'collecting', version = version + 1, updated_at = now()
      where id = v_proposal.id;
  elsif v_kind in ('submit_vendor_windows','submit_resident_windows') then
    v_windows := p_action->'windows';
    if jsonb_typeof(v_windows) is distinct from 'array' or jsonb_array_length(v_windows) > 32 then
      raise exception 'invalid windows'; end if;
    for v_window in select value from jsonb_array_elements(v_windows) loop
      if nullif(v_window->>'startIso','') is null or nullif(v_window->>'endIso','') is null then
        raise exception 'window endpoints required'; end if;
      v_start := (v_window->>'startIso')::timestamptz;
      v_end := (v_window->>'endIso')::timestamptz;
      if v_start >= v_end or v_end > now() + interval '180 days' or v_end <= now()
        or v_end - v_start > interval '24 hours' then raise exception 'invalid window interval'; end if;
    end loop;
    if v_kind = 'submit_vendor_windows' then
      update public.vendor_coordination_proposals set vendor_windows = v_windows,
        quote_revision = quote_revision + 1, vendor_confirmed_revision = null,
        resident_confirmed_revision = null, selected_start_at = null, status = 'collecting',
        version = version + 1, updated_at = now() where id = v_proposal.id;
    else
      update public.vendor_coordination_proposals set resident_windows = v_windows,
        quote_revision = quote_revision + 1, vendor_confirmed_revision = null,
        resident_confirmed_revision = null, selected_start_at = null, status = 'collecting',
        version = version + 1, updated_at = now() where id = v_proposal.id;
    end if;
  elsif v_kind = 'select_time' then
    v_start := nullif(p_action->>'selected_start_iso','')::timestamptz;
    if v_start is null or v_start <= now() or v_proposal.duration_minutes is null then raise exception 'invalid visit time'; end if;
    v_end := v_start + make_interval(mins => v_proposal.duration_minutes);
    if not exists (select 1 from jsonb_array_elements(v_proposal.vendor_windows) w
       where (w->>'startIso')::timestamptz <= v_start and (w->>'endIso')::timestamptz >= v_end)
       or not exists (select 1 from jsonb_array_elements(v_proposal.resident_windows) w
       where (w->>'startIso')::timestamptz <= v_start and (w->>'endIso')::timestamptz >= v_end) then
      raise exception 'selected time outside agreed windows'; end if;
    update public.vendor_coordination_proposals set selected_start_at = v_start,
      quote_revision = quote_revision + 1, vendor_confirmed_revision = null,
      resident_confirmed_revision = null, status = 'collecting', version = version + 1,
      updated_at = now() where id = v_proposal.id;
  elsif v_kind = 'confirm_vendor' then
    if v_proposal.selected_start_at is null or v_proposal.duration_minutes is null or v_proposal.scope is null then
      raise exception 'proposal terms incomplete'; end if;
    update public.vendor_coordination_proposals set vendor_confirmed_revision = quote_revision,
      status = case when resident_confirmed_revision = quote_revision then 'ready' else 'collecting' end,
      version = version + 1, updated_at = now() where id = v_proposal.id;
  elsif v_kind = 'confirm_resident' then
    if v_proposal.selected_start_at is null or v_proposal.duration_minutes is null or v_proposal.scope is null then
      raise exception 'proposal terms incomplete'; end if;
    update public.vendor_coordination_proposals set resident_confirmed_revision = quote_revision,
      status = case when vendor_confirmed_revision = quote_revision then 'ready' else 'collecting' end,
      version = version + 1, updated_at = now() where id = v_proposal.id;
  elsif v_kind = 'decline_manager' then
    update public.vendor_coordination_proposals set status = 'declined', version = version + 1,
      updated_at = now() where id = v_proposal.id;
  elsif v_kind = 'cancel' then
    perform set_config('proplane.vendor_coordination_write','on',true);
    update public.vendor_coordination_reservations set status = 'cancelled'
      where proposal_id = v_proposal.id and status = 'active';
    update public.vendor_coordination_proposals set status = 'cancelled', version = version + 1,
      updated_at = now() where id = v_proposal.id;
    if v_proposal.status = 'approved' and v_proposal.visit_type = 'repair' then
      update public.portal_work_order_records set row_data =
        (row_data - 'scheduledAtIso' - 'scheduled' - 'visitDurationMinutes') || jsonb_build_object('bucket','open'),
        updated_at = now() where id = v_work.id and row_data->>'scheduledAtIso' = to_char(v_proposal.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
    elsif v_proposal.status = 'approved' and v_proposal.visit_type = 'consultation' then
      update public.portal_work_order_records set row_data =
        row_data - 'consultationVisitAt' - 'consultationDurationMinutes', updated_at = now()
        where id = v_work.id and row_data->>'consultationVisitAt' =
          to_char(v_proposal.selected_start_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
    end if;
  elsif v_kind = 'approve_manager' then
    perform set_config('proplane.vendor_coordination_write','on',true);
    if v_proposal.status <> 'ready' or v_proposal.quote_revision = 0
      or v_proposal.vendor_confirmed_revision is distinct from v_proposal.quote_revision
      or v_proposal.resident_confirmed_revision is distinct from v_proposal.quote_revision
      or v_proposal.selected_start_at is null or v_proposal.duration_minutes is null
      or v_verified_phone is null then raise exception 'proposal lacks exact participant agreement or verified phone'; end if;
    v_start := v_proposal.selected_start_at;
    v_end := v_start + make_interval(mins => v_proposal.duration_minutes);
    if v_start <= now() then raise exception 'visit time has passed'; end if;
    if not exists (select 1 from jsonb_array_elements(v_proposal.vendor_windows) w
       where (w->>'startIso')::timestamptz <= v_start and (w->>'endIso')::timestamptz >= v_end)
       or not exists (select 1 from jsonb_array_elements(v_proposal.resident_windows) w
       where (w->>'startIso')::timestamptz <= v_start and (w->>'endIso')::timestamptz >= v_end) then
      raise exception 'confirmed slot no longer available'; end if;
    -- Lock both canonical identities. Every coordination approval takes the phone lock,
    -- plus the account lock when linked, before checking intervals across managers.
    perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:phone:' || v_verified_phone,0));
    if v_identity_user is not null then
      perform pg_advisory_xact_lock(hashtextextended('vendor-coordination:user:' || v_identity_user::text,0));
    end if;
    if exists (select 1 from public.vendor_coordination_reservations r
      left join public.manager_vendor_records historical_directory on historical_directory.id = r.vendor_directory_id
      where r.status = 'active'
      and r.proposal_id <> v_proposal.id and r.starts_at < v_end and r.ends_at > v_start
      and (r.vendor_phone_e164 = v_verified_phone or
        (v_identity_user is not null and
          (r.vendor_user_id = v_identity_user or historical_directory.vendor_user_id = v_identity_user)))) then
      raise exception 'vendor has a conflicting reservation'; end if;
    if exists (select 1 from public.portal_work_order_records legacy
      left join public.manager_vendor_records linked on linked.id = legacy.row_data->>'vendorId'
      left join public.vendor_coordination_phone_bindings lb on lb.vendor_directory_id = linked.id and lb.revoked_at is null
      where legacy.id <> v_work.id and coalesce(legacy.row_data->>'bucket','') not in ('completed','cancelled')
        and legacy.row_data->>'scheduledAtIso' is not null
        and (lb.phone_e164 = v_verified_phone or
          (v_identity_user is not null and (legacy.vendor_user_id = v_identity_user or linked.vendor_user_id = v_identity_user)))
        and (legacy.row_data->>'scheduledAtIso')::timestamptz < v_end
        and (legacy.row_data->>'scheduledAtIso')::timestamptz +
          make_interval(mins => coalesce(nullif(legacy.row_data->>'visitDurationMinutes','')::integer,60)) > v_start) then
      raise exception 'vendor has a conflicting scheduled service'; end if;
    if v_proposal.visit_type = 'repair' then
      v_total := v_proposal.labor_cents + v_proposal.materials_cents;
      if v_total is null or v_total <= 0 then raise exception 'repair quote missing'; end if;
      if exists (select 1 from public.work_order_bids b where b.work_order_id = v_work.id and b.status = 'accepted'
        and b.vendor_directory_id is distinct from v_proposal.vendor_directory_id) then
        raise exception 'another vendor bid already accepted'; end if;
      select * into v_bid from public.work_order_bids where work_order_id = v_work.id
        and vendor_directory_id = v_proposal.vendor_directory_id for update;
      if found and v_bid.status = 'accepted' then raise exception 'bid already accepted'; end if;
      if found then
        update public.work_order_bids set amount_cents = v_proposal.labor_cents,
          materials_cents = v_proposal.materials_cents, vendor_user_id = v_identity_user,
          proposed_time = v_start, note = v_proposal.scope, status = 'accepted', updated_at = now()
          where id = v_bid.id returning * into v_bid;
      else
        insert into public.work_order_bids(work_order_id,vendor_user_id,vendor_directory_id,manager_user_id,
          amount_cents,materials_cents,proposed_time,note,status,quote_mode)
        values(v_work.id,v_identity_user,v_proposal.vendor_directory_id,v_proposal.manager_user_id,
          v_proposal.labor_cents,v_proposal.materials_cents,v_start,v_proposal.scope,'accepted','upfront')
        returning * into v_bid;
      end if;
      update public.work_order_bids set status = 'declined', updated_at = now()
        where work_order_id = v_work.id and id <> v_bid.id and status = 'submitted';
      update public.portal_work_order_records set
        vendor_user_id = v_identity_user,
        row_data = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
          row_data || jsonb_build_object('vendorId',v_proposal.vendor_directory_id,
            'vendorCostCents',v_proposal.labor_cents,'materialsCostCents',v_proposal.materials_cents,
            'cost','$' || to_char(v_total::numeric / 100,'FM9999999990.00'),
            'scheduled',to_char(v_start at time zone 'America/Los_Angeles','Mon FMDD, YYYY FMHH12:MI AM'),
            'biddingOpen',false,'bucket','scheduled','visitDurationMinutes',v_proposal.duration_minutes),
          '{scheduledAtIso}',to_jsonb(to_char(v_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
          '{vendorName}',coalesce(v_directory.row_data->'name','null'::jsonb)),
          '{quoteScope}',to_jsonb(v_proposal.scope)),
          '{quoteExclusions}',to_jsonb(v_proposal.exclusions)),
          '{coordinationProposalId}',to_jsonb(v_proposal.id::text)), updated_at = now()
        where id = v_work.id;
    else
      -- A consultation has an independent fee approval and does not resolve repair bidding.
      update public.portal_work_order_records set row_data = row_data || jsonb_build_object(
        'consultationVisitAt',to_char(v_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'consultationDurationMinutes',v_proposal.duration_minutes,
        'consultationFeeCents',v_proposal.consultation_fee_cents,
        'consultationCoordinationProposalId',v_proposal.id::text), updated_at = now()
        where id = v_work.id;
    end if;
    insert into public.vendor_coordination_reservations
      (proposal_id,work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,vendor_phone_e164,starts_at,ends_at)
    values(v_proposal.id,v_work.id,v_proposal.manager_user_id,v_proposal.vendor_directory_id,
      v_identity_user,v_verified_phone,v_start,v_end);
    update public.vendor_coordination_proposals set status = 'approved', approved_by = v_actor,
      approved_at = now(), accepted_bid_id = case when v_proposal.visit_type = 'repair' then v_bid.id else null end,
      version = version + 1, updated_at = now() where id = v_proposal.id;
    select lower(trim(email)) into v_sender_email from public.profiles where id = v_proposal.manager_user_id;
    if nullif(v_sender_email,'') is null then raise exception 'manager sender email missing'; end if;
    insert into public.action_events(event_key,domain,event_type,category,manager_user_id,entity_id,
      sender_user_id,sender_email,occurred_at,payload)
    values('vendor_coordination:' || v_proposal.id::text || ':booked:' || v_proposal.quote_revision::text,
      'work_order','scheduled','maintenance',v_proposal.manager_user_id,v_work.id,
      v_proposal.manager_user_id,v_sender_email,now(),
      jsonb_build_object('proposalId',v_proposal.id,'visitType',v_proposal.visit_type,
        'vendorDirectoryId',v_proposal.vendor_directory_id,'propertyId',v_work.property_id,
        'startsAt',v_start,'endsAt',v_end,
        'durationMinutes',v_proposal.duration_minutes,'scope',v_proposal.scope,
        'exclusions',v_proposal.exclusions,'laborCents',v_proposal.labor_cents,
        'materialsCents',v_proposal.materials_cents,'consultationFeeCents',v_proposal.consultation_fee_cents,
        'quoteRevision',v_proposal.quote_revision))
    on conflict(event_key) do nothing returning id into v_event_id;
    if v_event_id is null then raise exception 'duplicate booked event key'; end if;
    insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
      status,next_attempt_at,rendered)
    values(v_event_id,'manager',v_proposal.manager_user_id::text,v_proposal.manager_user_id,
        'pending',now(),jsonb_build_object('subject','Service visit booked',
        'text','The ' || v_proposal.visit_type || ' visit is booked for ' || v_start::text ||
        '. Scope: ' || v_proposal.scope || '.',
        'smsText','Service ' || v_proposal.visit_type || ' booked for ' || v_start::text || '.'));
    if nullif(trim(v_work.resident_email),'') is not null then
      insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_email,
        status,next_attempt_at,rendered)
      values(v_event_id,'resident',lower(trim(v_work.resident_email)),lower(trim(v_work.resident_email)),
        'pending',now(),jsonb_build_object('subject','Your service visit is booked',
          'text','Your confirmed ' || v_proposal.visit_type || ' visit is booked for ' || v_start::text || '.',
          'smsText','Your confirmed service visit is booked for ' || v_start::text || '.'));
    end if;
    if v_identity_user is not null or nullif(trim(v_directory.row_data->>'email'),'') is not null then
      insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
        recipient_email,status,next_attempt_at,rendered)
      values(v_event_id,'vendor',coalesce(v_identity_user::text,lower(trim(v_directory.row_data->>'email'))),
        v_identity_user,nullif(lower(trim(v_directory.row_data->>'email')),''),
        'pending',now(),jsonb_build_object('subject','Service visit booked',
          'text','The confirmed ' || v_proposal.visit_type || ' visit is booked for ' || v_start::text || '.',
          'smsText','Confirmed service visit booked for ' || v_start::text || '.'));
    end if;
  end if;
  select * into v_proposal from public.vendor_coordination_proposals where id = v_proposal.id;
  if v_source is not null then
    insert into public.vendor_coordination_operations(proposal_id,source_message_id,action_kind,input_hash)
      values(v_proposal.id,v_source,v_kind,v_input_hash);
  end if;
  if v_kind <> 'approve_manager' then
    select lower(trim(email)) into v_sender_email from public.profiles where id = v_proposal.manager_user_id;
    if nullif(v_sender_email,'') is null then raise exception 'manager sender email missing'; end if;
    insert into public.action_events(event_key,domain,event_type,category,manager_user_id,entity_id,
      sender_user_id,sender_email,occurred_at,payload)
    values('vendor_coordination:' || v_proposal.id::text || ':version:' || v_proposal.version::text,
      'work_order',case when v_kind = 'cancel' then 'cancelled' else 'coordination_updated' end,
      'maintenance',v_proposal.manager_user_id,v_work.id,
      v_proposal.manager_user_id,v_sender_email,now(),
      jsonb_build_object('proposalId',v_proposal.id,'visitType',v_proposal.visit_type,
        'vendorDirectoryId',v_proposal.vendor_directory_id,'version',v_proposal.version,
        'propertyId',v_work.property_id,
        'reason',case when v_kind = 'request_revision' then v_proposal.revision_reason
          when v_kind = 'take_over' then v_proposal.takeover_reason else null end,
        'managerTakeover',v_proposal.manager_takeover,
        'quoteRevision',v_proposal.quote_revision,'action',v_kind,
        'startsAt',v_proposal.selected_start_at,'scope',v_proposal.scope,
        'laborCents',v_proposal.labor_cents,'materialsCents',v_proposal.materials_cents,
        'consultationFeeCents',v_proposal.consultation_fee_cents))
    on conflict(event_key) do nothing returning id into v_event_id;
    if v_event_id is not null then
      insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
        status,next_attempt_at,rendered)
      values(v_event_id,'manager',v_proposal.manager_user_id::text,v_proposal.manager_user_id,
        'pending',now(),jsonb_build_object(
          'subject',case when v_proposal.status = 'ready' then 'Service proposal ready for approval'
            else 'Service coordination updated' end,
          'text',case when v_proposal.status = 'ready' then
            'Ready for approval: ' || coalesce(v_directory.row_data->>'name','Vendor') ||
            ', ' || v_proposal.visit_type || ', scope: ' || coalesce(v_proposal.scope,'') ||
            ', exclusions: ' || coalesce(v_proposal.exclusions,'') || ', total: $' ||
            to_char((case when v_proposal.visit_type = 'consultation' then v_proposal.consultation_fee_cents
              else v_proposal.labor_cents + v_proposal.materials_cents end)::numeric / 100,'FM9999999990.00') ||
            ', duration: ' || v_proposal.duration_minutes::text || ' minutes, ' ||
            to_char(v_proposal.selected_start_at at time zone 'America/Los_Angeles','Mon FMDD, YYYY FMHH12:MI AM') ||
            ' Pacific. Vendor and resident confirmed revision ' || v_proposal.quote_revision::text || '.'
            else 'The ' || v_proposal.visit_type || ' visit proposal was updated (' || v_kind || ').' end));
      if v_kind in ('request_revision','take_over','cancel','decline_manager','select_time','submit_resident_windows')
        and (v_identity_user is not null or nullif(trim(v_directory.row_data->>'email'),'') is not null) then
        insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_user_id,
          recipient_email,status,next_attempt_at,rendered)
        values(v_event_id,'vendor',coalesce(v_identity_user::text,lower(trim(v_directory.row_data->>'email'))),
          v_identity_user,nullif(lower(trim(v_directory.row_data->>'email')),''),'pending',now(),
          jsonb_build_object('subject','Service coordination update',
            'text',case when v_kind = 'request_revision' then 'The manager requested a revision: ' || v_proposal.revision_reason
              when v_kind = 'take_over' then 'The manager will coordinate this service directly.'
              when v_kind = 'cancel' then 'The service visit was cancelled.'
              when v_kind = 'select_time' then 'Please confirm the exact ' || v_proposal.visit_type ||
                ' visit: ' || to_char(v_proposal.selected_start_at at time zone 'America/Los_Angeles','Mon FMDD, YYYY FMHH12:MI AM') ||
                ' Pacific for ' || v_proposal.duration_minutes::text || ' minutes. This is a proposal, not a booking.'
              when v_kind = 'submit_resident_windows' then 'The resident sent visit windows. Review the proposed time with the manager.'
              else 'The proposed service visit was declined.' end));
      end if;
      if v_kind in ('revise_quote','submit_vendor_windows','select_time','cancel')
        and nullif(trim(v_work.resident_email),'') is not null then
        insert into public.action_event_deliveries(event_id,audience,recipient_key,recipient_email,
          status,next_attempt_at,rendered)
        values(v_event_id,'resident',lower(trim(v_work.resident_email)),lower(trim(v_work.resident_email)),
          'pending',now(),jsonb_build_object(
            'subject',case when v_kind = 'cancel' then 'Service visit cancelled'
              when v_kind = 'select_time' then 'Confirm a service visit time'
              else 'Choose windows for a service visit' end,
            'text',case when v_kind = 'cancel' then 'The ' || v_proposal.visit_type || ' visit was cancelled.'
              when v_kind = 'select_time' then 'Please confirm the exact ' || v_proposal.visit_type ||
                ' visit: ' || to_char(v_proposal.selected_start_at at time zone 'America/Los_Angeles','Mon FMDD, YYYY FMHH12:MI AM') ||
                ' Pacific for ' || v_proposal.duration_minutes::text || ' minutes in Resident Services. No appointment is booked yet.'
              else 'Please submit available windows for a ' || v_proposal.visit_type ||
                ' visit in Resident Services. No appointment is booked yet.' end));
      end if;
    end if;
  end if;
  return to_jsonb(v_proposal);
end $$;
revoke all on function public.vendor_coordination_action(jsonb) from public,anon,authenticated;
grant execute on function public.vendor_coordination_action(jsonb) to service_role;
