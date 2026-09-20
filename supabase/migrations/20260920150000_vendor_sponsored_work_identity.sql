-- PropLane-sponsored vendor work identities.  These identities are platform
-- resources, never a manager entitlement or a vendor billing product.  Every
-- table is service-role only; the portal reads a deliberately small projection
-- through its authenticated route.

create table if not exists public.vendor_work_identity_runtime (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  max_active_identities integer not null default 0 check (max_active_identities >= 0),
  outbound_message_cap integer not null default 0 check (outbound_message_cap >= 0),
  updated_at timestamptz not null default now()
);
insert into public.vendor_work_identity_runtime (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.vendor_work_identities (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null unique references auth.users(id) on delete cascade,
  lifecycle_state text not null default 'not_started'
    check (lifecycle_state in ('not_started','provisioning','reconciling','ready','blocked','quarantined','disabled','released')),
  email_state text not null default 'not_started'
    check (email_state in ('not_started','provisioning','reconciling','ready','blocked','quarantined','disabled','released')),
  email_address text unique,
  email_provider_id text,
  email_send_ready boolean not null default false,
  email_receive_ready boolean not null default false,
  email_domain_verified boolean not null default false,
  phone_number text unique,
  phone_number_sid text,
  messaging_service_sid text,
  carrier_ready boolean not null default false,
  sms_registration_state text not null default 'not_submitted'
    check (sms_registration_state in ('not_submitted','pending','registered','failed','deregistering','deregistered')),
  sms_send_ready boolean not null default false,
  sms_receive_ready boolean not null default false,
  sms_state text not null default 'not_started'
    check (sms_state in ('not_started','provisioning','reconciling','ready','blocked','quarantined','disabled','released')),
  provider_operation_ref text,
  provision_request_id uuid,
  attachment_state text not null default 'not_started'
    check (attachment_state in ('not_started','provisioning','attached','reconciling','failed','released')),
  disabled_at timestamptz,
  released_at timestamptz,
  quarantined_at timestamptz,
  quarantine_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_work_identity_email_ready_requires_actual_readiness check (
    email_state <> 'ready' or (email_address is not null and email_provider_id is not null and email_domain_verified)
  ),
  constraint vendor_work_identity_sms_ready_requires_actual_readiness check (
    sms_state <> 'ready' or (phone_number is not null and phone_number_sid is not null and messaging_service_sid is not null and attachment_state = 'attached' and sms_receive_ready)
  ),
  constraint vendor_work_identity_sms_send_requires_registration check (
    not sms_send_ready or (carrier_ready and sms_registration_state = 'registered')
  )
);
create index if not exists vendor_work_identities_state_idx on public.vendor_work_identities (lifecycle_state, updated_at);

-- One durable provider operation per idempotency key.  A timeout is recorded
-- as reconciling and is never eligible for a blind second purchase/send.
create table if not exists public.vendor_work_identity_operations (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.vendor_work_identities(id) on delete cascade,
  vendor_user_id uuid not null references auth.users(id) on delete cascade,
  operation_kind text not null check (operation_kind in ('setup_email','setup_sms','reconcile_email','reconcile_sms','release','send_email','send_sms')),
  idempotency_key text not null,
  state text not null default 'claimed' check (state in ('claimed','calling_provider','succeeded','reconciling','failed','released')),
  provider_reference text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_user_id, operation_kind, idempotency_key)
);
create index if not exists vendor_work_identity_operations_identity_idx on public.vendor_work_identity_operations(identity_id, created_at desc);

create table if not exists public.vendor_work_identity_outbox (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.vendor_work_identities(id) on delete cascade,
  vendor_user_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid references public.vendor_work_identity_operations(id) on delete set null,
  idempotency_key text not null,
  channel text not null check (channel in ('email','sms')),
  recipient text not null,
  context_fingerprint text not null,
  subject text,
  body text not null,
  status text not null default 'authorized' check (status in ('authorized','calling_provider','sent','failed','reconciling','blocked','cancelled')),
  provider_message_id text,
  blocked_reason text,
  attempted_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_user_id, idempotency_key, channel)
);
create index if not exists vendor_work_identity_outbox_dispatch_idx on public.vendor_work_identity_outbox(status, created_at);
create unique index if not exists vendor_work_identity_outbox_provider_message_uniq
  on public.vendor_work_identity_outbox(channel, provider_message_id) where provider_message_id is not null;

create table if not exists public.vendor_work_identity_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.vendor_work_identity_outbox(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  provider_message_id text,
  state text not null check (state in ('calling_provider','sent','failed','reconciling','delivered','undelivered')),
  error_code text,
  created_at timestamptz not null default now(),
  unique (outbox_id, attempt_number)
);

create table if not exists public.vendor_work_identity_usage_events (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.vendor_work_identities(id) on delete cascade,
  vendor_user_id uuid not null references auth.users(id) on delete cascade,
  meter text not null check (meter in ('outbound_email','outbound_sms','inbound_email','inbound_sms')),
  quantity integer not null default 1 check (quantity > 0),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

-- This queue intentionally has no foreign key to an identity or auth user:
-- deletion must retain provider external IDs long enough to release them.
create table if not exists public.vendor_work_identity_release_queue (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid,
  identity_id uuid,
  phone_number_sid text,
  messaging_service_sid text,
  email_address text,
  state text not null default 'queued' check (state in ('queued','calling_provider','released','reconciling','failed')),
  idempotency_key text not null unique,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vendor_work_identity_release_queue_pending_idx on public.vendor_work_identity_release_queue(state, created_at);

-- Atomically create the identity shell exactly once.  Email is generated by
-- server code from the verified platform domain; callers cannot supply From.
create or replace function public.ensure_vendor_work_identity(
  p_vendor_user_id uuid,
  p_email_address text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  -- Lock the singleton runtime row before counting so concurrent setup calls
  -- cannot exceed sponsored platform capacity.  Disabled/zero capacity fails
  -- closed; server code maps the null return to a client-safe reason.
  perform 1 from public.vendor_work_identity_runtime where singleton = true and enabled = true for update;
  if not found then return null; end if;
  select id into v_id from public.vendor_work_identities where vendor_user_id = p_vendor_user_id for update;
  if v_id is not null then
    if p_email_address is not null then
      update public.vendor_work_identities set email_address = coalesce(email_address, p_email_address), updated_at = now() where id = v_id;
    end if;
    return v_id;
  end if;
  if (select count(*) from public.vendor_work_identities where released_at is null) >=
     (select max_active_identities from public.vendor_work_identity_runtime where singleton = true) then
    return null;
  end if;
  insert into public.vendor_work_identities(vendor_user_id, email_address)
    values (p_vendor_user_id, p_email_address)
    returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.claim_vendor_work_identity_operation(
  p_vendor_user_id uuid,
  p_identity_id uuid,
  p_operation_kind text,
  p_idempotency_key text
) returns table(operation_id uuid, claimed boolean, state text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with inserted as (
    insert into public.vendor_work_identity_operations(identity_id, vendor_user_id, operation_kind, idempotency_key)
    select p_identity_id, p_vendor_user_id, p_operation_kind, p_idempotency_key
    where exists (select 1 from public.vendor_work_identities where id = p_identity_id and vendor_user_id = p_vendor_user_id)
    on conflict (vendor_user_id, operation_kind, idempotency_key) do nothing
    returning vendor_work_identity_operations.id, vendor_work_identity_operations.state
  )
  select inserted.id, true, inserted.state from inserted
  union all
  select o.id, false, o.state
  from public.vendor_work_identity_operations o
  where o.vendor_user_id = p_vendor_user_id and o.operation_kind = p_operation_kind and o.idempotency_key = p_idempotency_key
    and not exists (select 1 from inserted)
  limit 1;
end;
$$;

-- Cap reservation and outbox authorization are one transaction.  The cap is
-- platform-owned; no manager wallet/entitlement is consulted anywhere here.
create or replace function public.claim_vendor_work_identity_outbound(
  p_vendor_user_id uuid,
  p_identity_id uuid,
  p_operation_id uuid,
  p_idempotency_key text,
  p_channel text,
  p_recipient text,
  p_context_fingerprint text,
  p_subject text,
  p_body text
) returns table(outbox_id uuid, claimed boolean, blocked_reason text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cap integer; v_used integer; v_ready boolean; v_existing uuid; v_operation_ok boolean;
begin
  if p_channel not in ('email','sms') then
    return query select null::uuid, false, 'invalid_channel'::text; return;
  end if;
  select outbound_message_cap into v_cap from public.vendor_work_identity_runtime where singleton = true and enabled = true for update;
  if not found then
    return query select null::uuid, false, 'provider_disabled'::text; return;
  end if;
  select case when p_channel = 'email' then email_state = 'ready' and email_send_ready else sms_state = 'ready' and sms_send_ready end
    into v_ready
  from public.vendor_work_identities where id = p_identity_id and vendor_user_id = p_vendor_user_id for update;
  select exists(select 1 from public.vendor_work_identity_operations o where o.id = p_operation_id and o.identity_id = p_identity_id and o.vendor_user_id = p_vendor_user_id and o.operation_kind = case when p_channel = 'email' then 'send_email' else 'send_sms' end)
    into v_operation_ok;
  select id into v_existing from public.vendor_work_identity_outbox
    where vendor_user_id = p_vendor_user_id and idempotency_key = p_idempotency_key and channel = p_channel;
  if v_existing is not null then
    return query select v_existing, false, null::text; return;
  end if;
  if coalesce(v_ready, false) = false then
    return query select null::uuid, false, 'identity_not_ready'::text; return;
  end if;
  if not v_operation_ok then
    return query select null::uuid, false, 'invalid_operation'::text; return;
  end if;
  select coalesce(sum(quantity), 0)::integer into v_used from public.vendor_work_identity_usage_events
    where identity_id = p_identity_id and meter in ('outbound_email','outbound_sms');
  if v_cap <= v_used then
    return query select null::uuid, false, 'platform_cap_reached'::text; return;
  end if;
  insert into public.vendor_work_identity_usage_events(identity_id,vendor_user_id,meter,idempotency_key)
    values (p_identity_id,p_vendor_user_id,case when p_channel = 'email' then 'outbound_email' else 'outbound_sms' end,
      'outbound:' || p_vendor_user_id::text || ':' || p_identity_id::text || ':' || p_idempotency_key || ':' || p_channel);
  insert into public.vendor_work_identity_outbox(identity_id,vendor_user_id,operation_id,idempotency_key,channel,recipient,context_fingerprint,subject,body)
    values (p_identity_id,p_vendor_user_id,p_operation_id,p_idempotency_key,p_channel,p_recipient,p_context_fingerprint,p_subject,p_body)
    returning id into v_existing;
  return query select v_existing, true, null::text;
end;
$$;

create or replace function public.queue_vendor_work_identity_release(p_vendor_user_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer := 0;
begin
  insert into public.vendor_work_identity_release_queue(
    vendor_user_id,identity_id,phone_number_sid,messaging_service_sid,email_address,idempotency_key
  )
  select i.vendor_user_id,i.id,i.phone_number_sid,i.messaging_service_sid,i.email_address,
    'release:' || i.id::text
  from public.vendor_work_identities i
  where i.vendor_user_id = p_vendor_user_id
    and i.phone_number_sid is not null
  on conflict (idempotency_key) do nothing;
  get diagnostics v_count = row_count;
  update public.vendor_work_identities
    set lifecycle_state = 'disabled', email_state = 'disabled', sms_state = 'disabled', disabled_at = coalesce(disabled_at, now()), sms_send_ready = false, email_send_ready = false,
        updated_at = now()
    where vendor_user_id = p_vendor_user_id and lifecycle_state not in ('released','disabled');
  return v_count;
end;
$$;

alter table public.vendor_work_identity_runtime enable row level security;
alter table public.vendor_work_identities enable row level security;
alter table public.vendor_work_identity_operations enable row level security;
alter table public.vendor_work_identity_outbox enable row level security;
alter table public.vendor_work_identity_delivery_attempts enable row level security;
alter table public.vendor_work_identity_usage_events enable row level security;
alter table public.vendor_work_identity_release_queue enable row level security;
revoke all on table public.vendor_work_identity_runtime, public.vendor_work_identities,
  public.vendor_work_identity_operations, public.vendor_work_identity_outbox,
  public.vendor_work_identity_delivery_attempts, public.vendor_work_identity_usage_events,
  public.vendor_work_identity_release_queue from anon, authenticated;
revoke execute on function public.ensure_vendor_work_identity(uuid,text),
  public.claim_vendor_work_identity_operation(uuid,uuid,text,text),
  public.claim_vendor_work_identity_outbound(uuid,uuid,uuid,text,text,text,text,text,text),
  public.queue_vendor_work_identity_release(uuid) from public, anon, authenticated;
grant execute on function public.ensure_vendor_work_identity(uuid,text),
  public.claim_vendor_work_identity_operation(uuid,uuid,text,text),
  public.claim_vendor_work_identity_outbound(uuid,uuid,uuid,text,text,text,text,text,text),
  public.queue_vendor_work_identity_release(uuid) to service_role;
